import React, { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/card";
import _ from 'lodash';
import Papa from 'papaparse';

// ==================== PSI IMPLEMENTATION ====================

// PSI Text Implementation for Browser
class TextPSI {
  constructor() {
    // Cache for redaction values to ensure consistent replacement
    this.redactionCache = new Map();
  }
  
  // Split content by mode
  splitContent(content, splitMode = 'line') {
    switch (splitMode) {
      case 'line':
        // Split by newlines and filter out empty lines
        return content.split(/\r?\n/).filter(line => line.trim().length > 0);
      
      case 'word':
        // Split into words and punctuation treating each as separate tokens
        const wordElements = [];
        let currentWord = '';
        
        for (let i = 0; i < content.length; i++) {
          const char = content[i];
          
          if (/[a-zA-Z0-9]/.test(char)) {
            // Alphanumeric characters form words
            currentWord += char;
          } else {
            // End current word if any
            if (currentWord) {
              wordElements.push(currentWord);
              currentWord = '';
            }
            
            // Add whitespace as a token (represented by space)
            if (/\s/.test(char)) {
              wordElements.push(' ');
            } else {
              // Add punctuation as individual tokens
              wordElements.push(char);
            }
          }
        }
        
        // Add final word if any
        if (currentWord) {
          wordElements.push(currentWord);
        }
        
        return wordElements;
      
      case 'char':
        // Split by individual characters, excluding whitespace
        return content.replace(/\s/g, '').split('');
      
      default:
        console.error(`Invalid split mode: ${splitMode}`);
        return content.split(/\r?\n/).filter(line => line.trim().length > 0);
    }
  }
  
  // Find intersection between local and remote content
  findIntersection(localContent, remoteContent, options = {}) {
    const splitMode = options.splitMode || 'line';
    const progressCallback = options.onProgress || (() => {});
    
    // Split content based on the specified mode
    const localElements = this.splitContent(localContent, splitMode);
    const remoteElements = this.splitContent(remoteContent, splitMode);
    
    // Report initial progress
    progressCallback(0, localElements.length);
    
    // Find intersection
    const intersection = [];
    let processedCount = 0;
    
    // Use a more efficient method for larger datasets
    const remoteSet = new Set(remoteElements);
    
    for (const element of localElements) {
      if (remoteSet.has(element)) {
        intersection.push(element);
      }
      
      // Update progress periodically
      processedCount++;
      if (processedCount % 10 === 0 || processedCount === localElements.length) {
        progressCallback(processedCount, localElements.length);
      }
    }
    
    // Create a set for faster lookups
    const intersectionSet = new Set(intersection);
    
    // For 'line' mode, highlight is straightforward
    if (splitMode === 'line') {
      const localLines = localContent.split(/\r?\n/);
      const remoteLines = remoteContent.split(/\r?\n/);
      
      const localHighlighted = localLines.map(line => {
        if (line.trim().length === 0) return line;
        return intersectionSet.has(line) ? 
          `<span class="text-green-500">${line}</span>` : 
          `<span class="text-red-500">${line}</span>`;
      }).join('\n');
      
      const remoteHighlighted = remoteLines.map(line => {
        if (line.trim().length === 0) return line;
        return intersectionSet.has(line) ? 
          `<span class="text-green-500">${line}</span>` : 
          `<span class="text-red-500">${line}</span>`;
      }).join('\n');
      
      // Return result with different formats
      return {
        intersection: intersection.join('\n'),
        localHighlighted,
        remoteHighlighted,
        intersectionSize: intersection.length,
        totalLocalElements: localElements.length,
        totalRemoteElements: remoteElements.length
      };
    }
    
    // For word and char modes, we'll use a simplified approach for this demo
    return {
      intersection: intersection.join(' '),
      localHighlighted: localContent,
      remoteHighlighted: remoteContent,
      intersectionSize: intersection.length,
      totalLocalElements: localElements.length,
      totalRemoteElements: remoteElements.length
    };
  }
}

// PSI Image Implementation for Browser
class ImagePSI {
  constructor(tileSize = 5) {
    this.tileSize = tileSize;
  }
  
  // Create canvas from image data URL
  async createCanvas(imageDataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const width = img.width;
        const height = img.height;
        canvas.width = width;
        canvas.height = height;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        
        resolve({
          canvas,
          ctx,
          width,
          height,
          imageData: ctx.getImageData(0, 0, width, height)
        });
      };
      img.onerror = reject;
      img.src = imageDataUrl;
    });
  }
  
  // Generate tiles from image data
  createTiles(canvasData) {
    const { width, height, imageData } = canvasData;
    const tileSize = this.tileSize;
    
    const tilesAcross = Math.floor(width / tileSize);
    const tilesDown = Math.floor(height / tileSize);
    const totalTiles = tilesAcross * tilesDown;
    
    console.log(`Dividing image into ${tilesAcross}x${tilesDown} tiles (total ${totalTiles}) with tile size ${tileSize}px`);
    
    const tiles = [];
    let tileIndex = 0;
    
    for (let ty = 0; ty < tilesDown; ty++) {
      for (let tx = 0; tx < tilesAcross; tx++) {
        // Format: tx + ty + pixel data (similar to the original algorithm)
        let elementStr = String(tx).padStart(4, '0') + String(ty).padStart(4, '0');
        
        for (let y = 0; y < tileSize; y++) {
          for (let x = 0; x < tileSize; x++) {
            const globalX = tx * tileSize + x;
            const globalY = ty * tileSize + y;
            const idx = (globalY * width + globalX) * 4;
            
            // Add RGB values (as in original algorithm)
            elementStr += String(imageData.data[idx]).padStart(3, '0') +
                       String(imageData.data[idx + 1]).padStart(3, '0') +
                       String(imageData.data[idx + 2]).padStart(3, '0');
          }
        }
        
        tiles.push({
          tx,
          ty,
          data: elementStr,
          index: tileIndex++
        });
      }
    }
    
    return {
      tiles,
      tilesAcross,
      tilesDown,
      totalTiles,
      width,
      height
    };
  }
  
  // Create result image showing intersection
  createResultImage(localCanvasData, localTileData, intersection) {
    const { canvas, ctx, width, height } = localCanvasData;
    const { tiles } = localTileData;
    const tileSize = this.tileSize;
    
    // Create a set of intersection tile indices for quick lookup
    const intersectionSet = new Set(intersection.map(item => item.localTile.index));
    
    // Create a copy of the canvas for the result
    const resultCanvas = document.createElement('canvas');
    resultCanvas.width = width;
    resultCanvas.height = height;
    const resultCtx = resultCanvas.getContext('2d');
    resultCtx.drawImage(canvas, 0, 0);
    
    // Get image data to modify
    const resultImageData = resultCtx.getImageData(0, 0, width, height);
    
    // Highlight non-intersecting tiles
    for (const tile of tiles) {
      if (!intersectionSet.has(tile.index)) {
        // Make non-intersecting tiles semi-transparent
        for (let y = 0; y < tileSize; y++) {
          for (let x = 0; x < tileSize; x++) {
            const globalX = tile.tx * tileSize + x;
            const globalY = tile.ty * tileSize + y;
            const idx = (globalY * width + globalX) * 4;
            
            // Make non-intersecting pixels more transparent and gray
            resultImageData.data[idx] = Math.round(resultImageData.data[idx] * 0.5);
            resultImageData.data[idx + 1] = Math.round(resultImageData.data[idx + 1] * 0.5);
            resultImageData.data[idx + 2] = Math.round(resultImageData.data[idx + 2] * 0.5);
            resultImageData.data[idx + 3] = Math.round(resultImageData.data[idx + 3] * 0.5);
          }
        }
      }
    }
    
    resultCtx.putImageData(resultImageData, 0, 0);
    
    return resultCanvas;
  }
  
  // Find intersection between two images
  async findIntersection(localImageDataUrl, remoteImageDataUrl) {
    try {
      // Create canvases from image data
      const localCanvasData = await this.createCanvas(localImageDataUrl);
      const remoteCanvasData = await this.createCanvas(remoteImageDataUrl);
      
      // Extract tiles from both images
      const localTileData = this.createTiles(localCanvasData);
      const remoteTileData = this.createTiles(remoteCanvasData);
      
      console.log(`Local image: ${localTileData.totalTiles} tiles`);
      console.log(`Remote image: ${remoteTileData.totalTiles} tiles`);
      
      // Find matching tiles
      const localTileMap = new Map(localTileData.tiles.map(tile => [tile.data, tile]));
      const remoteTileMap = new Map(remoteTileData.tiles.map(tile => [tile.data, tile]));
      
      const intersection = [];
      
      for (const [tileData, localTile] of localTileMap.entries()) {
        if (remoteTileMap.has(tileData)) {
          intersection.push({
            localTile,
            remoteTile: remoteTileMap.get(tileData)
          });
        }
      }
      
      console.log(`Found ${intersection.length} matching tiles out of ${localTileData.totalTiles}`);
      
      // Create result image
      const resultCanvas = this.createResultImage(localCanvasData, localTileData, intersection);
      
      // Return intersection data and images
      return {
        intersectionCount: intersection.length,
        totalTiles: localTileData.totalTiles,
        localImage: localImageDataUrl,
        remoteImage: remoteImageDataUrl,
        resultImage: resultCanvas.toDataURL()
      };
    } catch (error) {
      console.error("Error finding image intersection:", error);
      throw error;
    }
  }
}

// Simplified PSI engine with both implementations
const PSIEngine = {
  textPSI: new TextPSI(),
  imagePSI: new ImagePSI(5) // 5px tile size as in original algorithm
};

  // Create a tile grid component for visualizing image tiles
const TileGrid = ({ tileData, tileStatuses, tileSize = 5 }) => {
  if (!tileData || !tileStatuses) {
    console.log("TileGrid missing data:", { tileData, tileStatuses });
    return <div>Loading tile data...</div>;
  }
  
  console.log("Rendering TileGrid with statuses:", { 
    total: tileStatuses.length,
    unknown: tileStatuses.filter(s => s === 0).length,
    match: tileStatuses.filter(s => s === 1).length,
    noMatch: tileStatuses.filter(s => s === 2).length
  });
  
  const { tilesAcross, tilesDown, totalTiles } = tileData;
  
  // Create styles for tile display
  const gridStyle = {
    display: 'grid',
    gridTemplateColumns: `repeat(${tilesAcross}, ${tileSize}px)`,
    gap: '1px',
    width: `${tilesAcross * tileSize + tilesAcross - 1}px`,
    margin: '0 auto'
  };
  
  // Create tile elements
  const tileElements = [];
  
  for (let i = 0; i < totalTiles; i++) {
    const tile = tileData.tiles[i];
    const status = tileStatuses[i];
    
    // Determine tile color based on status
    let backgroundColor;
    
    if (status === 0) {
      // Unknown status - gray
      backgroundColor = '#cccccc';
    } else if (status === 1) {
      // Match - green
      backgroundColor = '#4ade80';
    } else {
      // No match - red
      backgroundColor = '#f87171';
    }
    
    // Create tile element
    tileElements.push(
      <div
        key={i}
        style={{
          width: `${tileSize}px`,
          height: `${tileSize}px`,
          backgroundColor,
          transition: 'background-color 0.2s ease'
        }}
        title={`Tile ${tile.tx},${tile.ty}`}
      />
    );
  }
  
  return (
    <div className="flex flex-col items-center mt-4">
      <div style={gridStyle}>
        {tileElements}
      </div>
    </div>
  );
};
const PSIApplication = () => {
  const [sessionId, setSessionId] = useState('');
  const [remoteSessionId, setRemoteSessionId] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [localFile, setLocalFile] = useState(null);
  const [remoteFile, setRemoteFile] = useState(null);
  const [resultData, setResultData] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [fileType, setFileType] = useState(''); // 'text' or 'image'
  const [progress, setProgress] = useState({ current: 0, total: 100, label: '', phase: '' });
  const [tilesData, setTilesData] = useState(null);
  
  const webSocket = useRef(null);
  const localFileContent = useRef(null);
  const fileInputRef = useRef(null);
  const dropZoneRef = useRef(null);
  
  // Setup session and WebSocket connection
  useEffect(() => {
    // Get or create a session ID
    const fetchSessionId = async () => {
      try {
        const response = await fetch('http://localhost:3001/session');
        const data = await response.json();
        setSessionId(data.sessionId);
        console.log("Session ID:", data.sessionId);
        
        // Connect to WebSocket once we have a session ID
        connectWebSocket(data.sessionId);
      } catch (err) {
        console.error("Error getting session ID:", err);
      }
    };
    
    fetchSessionId();
    
    // Setup drag and drop
    const dropZone = dropZoneRef.current;
    if (dropZone) {
      const preventDefault = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      
      const handleDrop = (e) => {
        preventDefault(e);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          handleFileSelect(e.dataTransfer.files[0]);
        }
      };
      
      dropZone.addEventListener('dragenter', preventDefault);
      dropZone.addEventListener('dragover', preventDefault);
      dropZone.addEventListener('dragleave', preventDefault);
      dropZone.addEventListener('drop', handleDrop);
      
      return () => {
        dropZone.removeEventListener('dragenter', preventDefault);
        dropZone.removeEventListener('dragover', preventDefault);
        dropZone.removeEventListener('dragleave', preventDefault);
        dropZone.removeEventListener('drop', handleDrop);
      };
    }
  }, []);
  
  // Connect to WebSocket server
  const connectWebSocket = (sid) => {
    // Close existing connection if any
    if (webSocket.current) {
      webSocket.current.close();
    }
    
    // Create new WebSocket connection
    const ws = new WebSocket('ws://localhost:3001');
    
    ws.onopen = () => {
      console.log("WebSocket connection established");
      
      // Register session ID
      ws.send(JSON.stringify({
        type: 'register',
        sessionId: sid
      }));
    };
    
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      
      switch (message.type) {
        case 'registered':
          console.log(`WebSocket registered for session ${message.sessionId}`);
          break;
          
        case 'file-meta':
          console.log("Received file metadata:", message.data);
          setRemoteFile({
            name: message.data.fileName,
            size: message.data.fileSize,
            type: message.data.fileType
          });
          break;
          
        case 'file-content':
          console.log("Received file content with size:", 
                     message.data.content ? message.data.content.length : 'unknown');
          
          // Reset any existing results and tile data when starting a new process
          setResultData(null);
          setTilesData(null);
          
          // Wait a short time to ensure UI updates before starting processing
          setTimeout(() => {
            processReceivedFile(message.data.content, message.data.fileType);
          }, 100);
          break;
          
        case 'request-file':
          console.log("Remote peer requested file");
          if (localFileContent.current) {
            sendMessage(message.sourceId, 'file-content', {
              content: localFileContent.current,
              fileType: fileType
            });
          }
          break;
          
        case 'connect-request':
          console.log(`Received connection request from ${message.sourceId}`);
          setRemoteSessionId(message.sourceId);
          setConnectionStatus('connected');
          
          // Send acknowledgement
          sendMessage(message.sourceId, 'connect-response', {
            accepted: true
          });
          break;
          
        case 'connect-response':
          console.log(`Connection response from ${message.sourceId}:`, message.data);
          if (message.data.accepted) {
            setConnectionStatus('connected');
          } else {
            setConnectionStatus('disconnected');
            alert('Connection rejected by remote peer');
          }
          break;
          
        case 'disconnect':
          console.log(`Disconnected from ${message.sourceId}`);
          if (message.sourceId === remoteSessionId) {
            setRemoteSessionId('');
            setConnectionStatus('disconnected');
            setRemoteFile(null);
          }
          break;
          
        case 'error':
          console.error("WebSocket error:", message.error);
          break;
      }
    };
    
    ws.onclose = () => {
      console.log("WebSocket connection closed");
      setConnectionStatus('disconnected');
    };
    
    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };
    
    webSocket.current = ws;
  };
  
  // Send message through WebSocket
  const sendMessage = (targetId, messageType, messageData) => {
    if (!webSocket.current || webSocket.current.readyState !== WebSocket.OPEN) {
      console.error("WebSocket not connected");
      return false;
    }
    
    console.log(`Sending ${messageType} to ${targetId}`, messageData);
    
    webSocket.current.send(JSON.stringify({
      type: 'relay',
      targetId,
      messageType,
      messageData
    }));
    
    return true;
  };
  
  // Handle file selection
  const handleFileSelect = async (file) => {
    if (!file) return;
    
    setLocalFile(file);
    
    // Determine file type
    const fileType = file.type.startsWith('image/') ? 'image' : 'text';
    setFileType(fileType);
    
    // Read file content
    const reader = new FileReader();
    
    reader.onload = async (e) => {
      const content = e.target.result;
      localFileContent.current = content;
      
      // If connected, send file metadata
      if (connectionStatus === 'connected' && remoteSessionId) {
        sendMessage(remoteSessionId, 'file-meta', {
          fileType,
          fileName: file.name,
          fileSize: file.size
        });
      }
    };
    
    if (fileType === 'image') {
      reader.readAsDataURL(file);
    } else {
      reader.readAsText(file);
    }
  };
  
  // Create connection to remote peer
  const createConnection = async () => {
    if (!remoteSessionId) {
      alert('Please enter remote peer session ID');
      return;
    }
    
    // Send connection request
    const sent = sendMessage(remoteSessionId, 'connect-request', {});
    
    if (sent) {
      setConnectionStatus('connecting');
    } else {
      alert('Failed to send connection request');
    }
  };
  
  // Process received file and find intersection
  const processReceivedFile = async (content, type) => {
    if (!localFileContent.current) {
      console.error("No local file content");
      return;
    }
    
    console.log("Starting to process file of type:", type);
    
    setIsProcessing(true);
    setProgress({
      current: 0,
      total: 100,
      label: "Starting...",
      phase: "starting"
    });
    
    // Force UI update with a small delay
    await new Promise(resolve => setTimeout(resolve, 50));
    
    try {
      let result;
      
      if (type === 'text') {
        console.log("Processing text file");
        result = await PSIEngine.textPSI.findIntersection(
          localFileContent.current,
          content,
          {
            onProgress: (current, total) => {
              console.log(`Text processing progress: ${current}/${total}`);
              setProgress({
                current,
                total,
                label: `Processed ${current} of ${total} items`,
                phase: "processing"
              });
            }
          }
        );
      } else if (type === 'image') {
        console.log("Processing image file");
        // For image PSI, we'll track partial results for the tile grid view
        setTilesData(null);
        
        result = await PSIEngine.imagePSI.findIntersection(
          localFileContent.current,
          content,
          {
            onProgress: (current, total, label) => {
              console.log(`Image processing progress: ${current}/${total} - ${label}`);
              setProgress({
                current,
                total,
                label: label || `Processed ${current} of ${total} items`,
                phase: "processing"
              });
            },
            onPartialResults: (partialData) => {
              console.log("Received partial results:", partialData.matchedCount);
              setTilesData(partialData);
            }
          }
        );
        
        console.log("Image processing complete, updating final tiles data");
        // Update final tiles data with complete information
        setTilesData({
          tileStatuses: result.tileStatuses,
          localTileData: result.localTileData,
          matchedCount: result.intersectionCount
        });
      }
      
      console.log("Processing complete, setting result data");
      setResultData(result);
    } catch (err) {
      console.error("Error processing files:", err);
      alert("Error processing files: " + err.message);
    } finally {
      setIsProcessing(false);
      setProgress({
        current: 100,
        total: 100,
        label: "Complete",
        phase: "complete"
      });
    }
  };
  
  // Request file from remote peer
  const requestRemoteFile = () => {
    if (connectionStatus === 'connected' && remoteSessionId) {
      sendMessage(remoteSessionId, 'request-file', {});
    }
  };
  
  // Find intersection between files
  const findIntersection = () => {
    if (!localFile || !remoteFile) {
      alert("Both peers need to select files first");
      return;
    }
    
    console.log("Requesting remote file");
    requestRemoteFile();
  };
  
  // Disconnect from remote peer
  const disconnect = () => {
    if (remoteSessionId) {
      sendMessage(remoteSessionId, 'disconnect', {});
    }
    
    setRemoteSessionId('');
    setConnectionStatus('disconnected');
    setRemoteFile(null);
    setResultData(null);
  };
  
  return (
    <div className="flex flex-col min-h-screen">
      <header className="border-b p-4 bg-gray-50">
        <h1 className="text-2xl font-bold text-center">Private Set Intersection</h1>
      </header>
      
      <main className="flex flex-col flex-1 p-4 md:p-6 gap-6">
        {/* Connection Panel */}
        <Card>
          <CardHeader>
            <CardTitle>Connection Setup</CardTitle>
            <CardDescription>
              Your Session ID: <span className="font-mono bg-gray-100 p-1 rounded">{sessionId || "Loading..."}</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-4">
                <label className="w-32">Remote Session ID:</label>
                <input 
                  type="text" 
                  value={remoteSessionId} 
                  onChange={(e) => setRemoteSessionId(e.target.value)}
                  placeholder="Enter remote peer session ID" 
                  className="flex-1 p-2 border rounded"
                  disabled={connectionStatus !== 'disconnected'}
                />
              </div>
              
              <div className="flex items-center gap-4">
                <label className="w-32">Status:</label>
                <span className={
                  connectionStatus === 'connected' ? 'text-green-500' :
                  connectionStatus === 'connecting' ? 'text-yellow-500' :
                  'text-red-500'
                }>
                  {connectionStatus === 'connected' ? 'Connected' :
                   connectionStatus === 'connecting' ? 'Connecting...' :
                   'Disconnected'}
                </span>
              </div>
              
              <div className="flex justify-end">
                {connectionStatus === 'disconnected' ? (
                  <button 
                    onClick={createConnection}
                    className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                  >
                    Connect
                  </button>
                ) : (
                  <button 
                    onClick={disconnect}
                    className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
        
        {/* File Selection Panel */}
        <Card>
          <CardHeader>
            <CardTitle>File Selection</CardTitle>
            <CardDescription>
              Drag & drop or select a file to process
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div 
              ref={dropZoneRef}
              className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-blue-500 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              {localFile ? (
                <div className="flex flex-col gap-2">
                  <span className="text-lg font-medium">{localFile.name}</span>
                  <span className="text-sm text-gray-500">
                    {(localFile.size / 1024).toFixed(2)} KB
                  </span>
                  <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full inline-block mx-auto">
                    {fileType === 'image' ? 'Image' : 'Text'}
                  </span>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <span className="text-lg">Drop file here or click to select</span>
                  <span className="text-sm text-gray-500">Supports text files and images</span>
                </div>
              )}
              
              <input 
                ref={fileInputRef}
                type="file" 
                className="hidden"
                onChange={(e) => handleFileSelect(e.target.files[0])}
                accept="text/*,image/*"
              />
            </div>
            
            {remoteFile && (
              <div className="mt-4 p-4 bg-gray-50 rounded">
                <h3 className="font-medium">Remote Peer's File:</h3>
                <div className="flex flex-col mt-2">
                  <span>{remoteFile.name}</span>
                  <span className="text-sm text-gray-500">
                    {(remoteFile.size / 1024).toFixed(2)} KB
                  </span>
                  <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded-full inline-block mt-1" style={{width: 'fit-content'}}>
                    {remoteFile.type === 'image' ? 'Image' : 'Text'}
                  </span>
                </div>
              </div>
            )}
          </CardContent>
          <CardFooter className="justify-end">
            <button
              onClick={findIntersection}
              disabled={!localFile || !remoteFile || connectionStatus !== 'connected' || isProcessing}
              className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {isProcessing ? 'Processing...' : 'Find Intersection'}
            </button>
          </CardFooter>
        </Card>
        
        {/* Results Panel */}
        {resultData && (
          <Card>
            <CardHeader>
              <CardTitle>Intersection Results</CardTitle>
              <CardDescription>
                {fileType === 'image' 
                  ? `Found ${resultData.intersectionCount} matching tiles out of ${resultData.totalTiles}`
                  : 'Green text shows matching content, red shows differences'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {fileType === 'image' ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="flex flex-col items-center">
                    <h3 className="font-medium mb-2">Local Image</h3>
                    <img src={resultData.localImage} alt="Local" className="max-w-full border" />
                  </div>
                  
                  <div className="flex flex-col items-center">
                    <h3 className="font-medium mb-2">Intersection Result</h3>
                    <img src={resultData.resultImage} alt="Result" className="max-w-full border" />
                  </div>
                  
                  <div className="flex flex-col items-center">
                    <h3 className="font-medium mb-2">Remote Image</h3>
                    <img src={resultData.remoteImage} alt="Remote" className="max-w-full border" />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex flex-col">
                    <h3 className="font-medium mb-2">Local Text (with highlights)</h3>
                    <div className="p-4 border rounded bg-gray-50 whitespace-pre-wrap overflow-auto max-h-96">
                      <div dangerouslySetInnerHTML={{ __html: resultData.localHighlighted }} />
                    </div>
                  </div>
                  
                  <div className="flex flex-col">
                    <h3 className="font-medium mb-2">Remote Text (with highlights)</h3>
                    <div className="p-4 border rounded bg-gray-50 whitespace-pre-wrap overflow-auto max-h-96">
                      <div dangerouslySetInnerHTML={{ __html: resultData.remoteHighlighted }} />
                    </div>
                  </div>
                  
                  <div className="col-span-1 md:col-span-2">
                    <h3 className="font-medium mb-2">Intersection Only</h3>
                    <div className="p-4 border rounded bg-gray-50 whitespace-pre-wrap overflow-auto max-h-96">
                      {resultData.intersection || <em>No matching content found</em>}
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </main>
      
      <footer className="border-t p-4 text-center text-gray-500 text-sm">
        Private Set Intersection (PSI) - Peer-to-Peer File Analysis
      </footer>
    </div>
  );
};

export default PSIApplication;
