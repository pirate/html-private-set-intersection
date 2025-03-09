#!/usr/bin/env bun
const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const PSI = require('@openmined/psi.js');
const { PNG } = require('pngjs');

// Simple progress bar helper
function printProgressBar(current, total, label) {
  const barLength = 20;
  const percent = current / total;
  const filledLength = Math.round(percent * barLength);
  const bar = '#'.repeat(filledLength) + '-'.repeat(barLength - filledLength);
  process.stderr.write(`\r${label} [${bar}] ${(percent * 100).toFixed(1)}%`);
  if (current === total) {
    process.stderr.write('\n');
  }
}

// CLI options
program
  .option('-s, --server', 'Run as server')
  .option('-c, --client <host:port>', 'Run as client and connect to server')
  .option('-h, --host <host>', 'Host to bind server to', '0.0.0.0')
  .option('-p, --port <port>', 'Port to bind server to', '5995')
  .option('-f, --file <path>', 'Path to PNG image file for PSI')
  .option('--fpr <rate>', 'False positive rate (default: 0.001)', '0.001')
  .option('--reveal-intersection', 'Reveal the actual intersection (output final image with non-intersecting tiles smoothed)')
  .parse(process.argv);

const options = program.opts();

if (!options.file) {
  console.error('Error: --file is required');
  process.exit(1);
}

if (!options.server && !options.client) {
  console.error('Error: Either --server or --client must be specified');
  process.exit(1);
}

/**
 * Reads a PNG image and divides it into 5×5 pixel tiles.
 * For PSI, only the RGB channels are used (alpha is ignored).
 * Returns an object containing:
 * - elements: an array of strings encoding tile coordinates and raw RGB pixel data (for PSI)
 * - png: the parsed PNG image (with original RGBA data)
 * - tileInfo: array of tile metadata objects { tx, ty, index }
 * - width, height: dimensions of the image
 * - tilesAcross, tilesDown: number of tiles horizontally and vertically
 * - tileSize: the tile size (5)
 */
function readImageTiles(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    const png = PNG.sync.read(data);
    const width = png.width;
    const height = png.height;
    console.error(`Loaded image ${filePath} with dimensions ${width}×${height}`);
    
    const tileSize = 5;
    const tilesAcross = Math.floor(width / tileSize);
    const tilesDown = Math.floor(height / tileSize);
    const totalTiles = tilesAcross * tilesDown;
    console.error(`Dividing image into ${tilesAcross} tiles across and ${tilesDown} tiles down (total ${totalTiles} tiles)`);
    
    const elements = [];
    const tileInfo = [];
    let tileIndex = 0;
    
    // Process each row and update progress
    for (let ty = 0; ty < tilesDown; ty++) {
      for (let tx = 0; tx < tilesAcross; tx++) {
        // Allocate buffer for PSI element (5×5 pixels, 3 bytes per pixel)
        const psiBuffer = Buffer.alloc(tileSize * tileSize * 3);
        let bufferOffset = 0;
        for (let y = 0; y < tileSize; y++) {
          for (let x = 0; x < tileSize; x++) {
            const globalX = tx * tileSize + x;
            const globalY = ty * tileSize + y;
            const idx = (globalY * width + globalX) * 4;
            // Copy R, G, B only (skip alpha)
            psiBuffer[bufferOffset++] = png.data[idx];
            psiBuffer[bufferOffset++] = png.data[idx + 1];
            psiBuffer[bufferOffset++] = png.data[idx + 2];
          }
        }
        const psiHex = psiBuffer.toString('hex');
        const elementString = `${tx},${ty}-${psiHex}`;
        elements.push(elementString);
        tileInfo.push({ tx, ty, index: tileIndex });
        tileIndex++;
      }
      printProgressBar(ty + 1, tilesDown, "Tile extraction progress:");
    }
    
    console.error(`Extracted ${elements.length} tile elements from image.`);
    return { elements, png, tileInfo, width, height, tilesAcross, tilesDown, tileSize };
  } catch (err) {
    console.error(`Error reading PNG file ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Helper function that computes the average color of a tile from the PNG image.
 * It iterates over all pixels in the tile located at (tx, ty).
 */
function getTileAverageColor(png, tx, ty, tileSize, width) {
  let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
  let count = 0;
  for (let y = 0; y < tileSize; y++) {
    for (let x = 0; x < tileSize; x++) {
      const globalX = tx * tileSize + x;
      const globalY = ty * tileSize + y;
      const idx = (globalY * width + globalX) * 4;
      sumR += png.data[idx];
      sumG += png.data[idx + 1];
      sumB += png.data[idx + 2];
      sumA += png.data[idx + 3];
      count++;
    }
  }
  return {
    r: Math.round(sumR / count),
    g: Math.round(sumG / count),
    b: Math.round(sumB / count),
    a: Math.round(sumA / count)
  };
}

// Server mode: set up the PSI server using the image tiles.
async function runServer() {
  const psi = await PSI();
  const { elements } = readImageTiles(options.file);
  const revealIntersection = !!options.revealIntersection;
  const server = psi.server.createWithNewKey(revealIntersection);
  
  console.error(`Server started on ${options.host}:${options.port}`);
  console.error(`Loaded ${elements.length} tile elements from image`);
  console.error(`Reveal intersection: ${revealIntersection}`);
  
  // Create Bun HTTP server
  const bunServer = Bun.serve({
    port: parseInt(options.port, 10),
    hostname: options.host,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname === '/setup') {
        const numClientElements = parseInt(req.headers.get('x-num-elements') || '100', 10);
        const fpr = parseFloat(options.fpr);
        console.error(`Creating setup for client with ${numClientElements} elements (FPR: ${fpr})`);
        
        const serverSetup = server.createSetupMessage(
          fpr,
          numClientElements,
          elements,
          psi.dataStructure.GCS
        );
        const serializedSetup = Buffer.from(serverSetup.serializeBinary());
        return new Response(serializedSetup, {
          headers: { 'Content-Type': 'application/octet-stream' }
        });
      } else if (req.method === 'POST' && url.pathname === '/request') {
        try {
          const requestData = await req.arrayBuffer();
          const clientRequest = psi.request.deserializeBinary(new Uint8Array(requestData));
          const serverResponse = server.processRequest(clientRequest);
          const serializedResponse = Buffer.from(serverResponse.serializeBinary());
          return new Response(serializedResponse, {
            headers: { 'Content-Type': 'application/octet-stream' }
          });
        } catch (error) {
          console.error('Error processing client request:', error);
          return new Response('Error processing request', { status: 500 });
        }
      } else {
        return new Response('Not found', { status: 404 });
      }
    },
    error(err) {
      console.error(`Server error: ${err.message}`);
      return new Response('Server error', { status: 500 });
    }
  });
  
  console.error(`Server is listening on ${bunServer.hostname}:${bunServer.port}`);
}

// Client mode: perform PSI and then output the final image.
async function runClient() {
  const [host, port] = options.client.split(':');
  const targetPort = parseInt(port || '5995', 10);
  const { elements, png, tileInfo, width, height, tilesAcross, tilesDown, tileSize } = readImageTiles(options.file);
  const revealIntersection = !!options.revealIntersection;
  
  console.error(`Connecting to server at ${host}:${targetPort}`);
  console.error(`Loaded ${elements.length} tile elements from image`);
  console.error(`Reveal intersection: ${revealIntersection}`);
  
  try {
    const psi = await PSI();
    const client = psi.client.createWithNewKey(revealIntersection);
    
    // Step 1: Get the server setup
    const setupResponse = await fetch(`http://${host}:${targetPort}/setup`, {
      method: 'GET',
      headers: { 'X-Num-Elements': elements.length.toString() }
    });
    
    if (!setupResponse.ok) {
      throw new Error(`HTTP Error: ${setupResponse.status}`);
    }
    
    const setupData = await setupResponse.arrayBuffer();
    
    // Step 2: Create and send the client request
    const clientRequest = client.createRequest(elements);
    const serializedRequest = clientRequest.serializeBinary();
    
    const responseResult = await fetch(`http://${host}:${targetPort}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: serializedRequest
    });
    
    if (!responseResult.ok) {
      throw new Error(`HTTP Error: ${responseResult.status}`);
    }
    
    const responseData = await responseResult.arrayBuffer();
    
    // Step 3: Process the server's response
    const serverSetup = psi.serverSetup.deserializeBinary(new Uint8Array(setupData));
    const serverResponse = psi.response.deserializeBinary(new Uint8Array(responseData));
    
    if (revealIntersection) {
      // Get the intersection indices (corresponding to tileInfo order)
      const intersection = client.getIntersection(serverSetup, serverResponse);
      console.error(`Intersection contains ${intersection.length} tiles out of ${elements.length}`);
      
      const intersectionSet = new Set(intersection);
      
      // Mark non-intersecting tiles in the PNG:
      // For each tile not in the intersection, overwrite its pixels with the marker (black with alpha 0)
      for (let i = 0; i < tileInfo.length; i++) {
        if (!intersectionSet.has(i)) {
          const { tx, ty } = tileInfo[i];
          for (let y = 0; y < tileSize; y++) {
            for (let x = 0; x < tileSize; x++) {
              const globalX = tx * tileSize + x;
              const globalY = ty * tileSize + y;
              const idx = (globalY * width + globalX) * 4;
              png.data[idx] = 0;
              png.data[idx + 1] = 0;
              png.data[idx + 2] = 0;
              png.data[idx + 3] = 0; // marker alpha (non-intersecting)
            }
          }
        }
        printProgressBar(i + 1, tileInfo.length, "Marking tiles progress:");
      }
      
      // Smoothing pass:
      // For each tile that is marked (non-intersecting), check its four cardinal neighbors.
      // If a neighbor is intersecting (its top-left pixel alpha is 255), include its average color.
      for (let i = 0; i < tileInfo.length; i++) {
        const { tx, ty } = tileInfo[i];
        const globalIdx = ((ty * tileSize) * width + tx * tileSize) * 4;
        // Check if this tile is marked (non-intersecting)
        if (png.data[globalIdx + 3] !== 255) {
          const neighborCoords = [];
          if (tx > 0) neighborCoords.push({ tx: tx - 1, ty });
          if (tx < tilesAcross - 1) neighborCoords.push({ tx: tx + 1, ty });
          if (ty > 0) neighborCoords.push({ tx, ty: ty - 1 });
          if (ty < tilesDown - 1) neighborCoords.push({ tx, ty: ty + 1 });
          
          const neighborColors = [];
          for (const { tx: ntx, ty: nty } of neighborCoords) {
            const nGlobalIdx = ((nty * tileSize) * width + ntx * tileSize) * 4;
            // If neighbor's top-left pixel has alpha 255, consider it intersecting
            if (png.data[nGlobalIdx + 3] === 255) {
              neighborColors.push(getTileAverageColor(png, ntx, nty, tileSize, width));
            }
          }
          
          let avgColor;
          if (neighborColors.length > 0) {
            let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
            for (const col of neighborColors) {
              sumR += col.r;
              sumG += col.g;
              sumB += col.b;
              sumA += col.a;
            }
            avgColor = {
              r: Math.round(sumR / neighborColors.length),
              g: Math.round(sumG / neighborColors.length),
              b: Math.round(sumB / neighborColors.length),
              a: 255
            };
          } else {
            avgColor = { r: 255, g: 255, b: 255, a: 255 };
          }
          
          // Fill the non-intersecting tile with the computed average color.
          for (let y = 0; y < tileSize; y++) {
            for (let x = 0; x < tileSize; x++) {
              const globalX = tx * tileSize + x;
              const globalY = ty * tileSize + y;
              const idx = (globalY * width + globalX) * 4;
              png.data[idx] = avgColor.r;
              png.data[idx + 1] = avgColor.g;
              png.data[idx + 2] = avgColor.b;
              png.data[idx + 3] = 255;
            }
          }
        }
        printProgressBar(i + 1, tileInfo.length, "Smoothing pass progress:");
      }
      
      console.error(`Smoothing pass complete: non-intersecting tiles have been replaced with neighbor-averaged colors.`);
      const outputBuffer = PNG.sync.write(png);
      const outputPath = path.join(process.cwd(), 'psi_output.png');
      fs.writeFileSync(outputPath, outputBuffer);
      console.error(`Final image written to ${outputPath}`);
    } else {
      const intersectionSize = client.getIntersectionSize(serverSetup, serverResponse);
      console.error(`Intersection size: ${intersectionSize}`);
      console.log(`Intersection size: ${intersectionSize}`);
    }
    
  } catch (error) {
    console.error(`Client error: ${error.message}`);
    process.exit(1);
  }
}

if (options.server) {
  runServer();
} else if (options.client) {
  runClient();
}
