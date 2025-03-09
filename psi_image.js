#!/usr/bin/env bun
const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const PSI = require('@openmined/psi.js');
const { PNG } = require('pngjs');

// CLI options
program
  .option('-s, --server', 'Run as server')
  .option('-c, --client <host:port>', 'Run as client and connect to server')
  .option('-h, --host <host>', 'Host to bind server to', '0.0.0.0')
  .option('-p, --port <port>', 'Port to bind server to', '5995')
  .option('-f, --file <path>', 'Path to PNG image file for PSI')
  .option('--fpr <rate>', 'False positive rate (default: 0.001)', '0.001')
  .option('--reveal-intersection', 'Reveal the actual intersection (output final image with non-intersecting tiles white)')
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
 * Reads a PNG image from the provided file path and divides it into 10×10 pixel tiles.
 * Each tile is represented as a string that encodes its tile coordinates and raw pixel data.
 * Also returns an array of tile metadata for later image reassembly.
 */
function readImageTiles(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    const png = PNG.sync.read(data);
    const width = png.width;
    const height = png.height;
    console.error(`Loaded image ${filePath} with dimensions ${width}×${height}`);
    
    const tileSize = 10;
    const tilesAcross = Math.floor(width / tileSize);
    const tilesDown = Math.floor(height / tileSize);
    const totalTiles = tilesAcross * tilesDown;
    console.error(`Dividing image into ${tilesAcross} tiles across and ${tilesDown} tiles down (total ${totalTiles} tiles)`);

    const elements = [];
    const tileInfo = [];
    let tileIndex = 0;
    
    for (let ty = 0; ty < tilesDown; ty++) {
      console.error(`Processing tile row ${ty + 1} of ${tilesDown}`);
      for (let tx = 0; tx < tilesAcross; tx++) {
        // Allocate buffer for the tile (10×10 pixels, 4 bytes per pixel)
        const tileBuffer = Buffer.alloc(tileSize * tileSize * 4);
        let bufferOffset = 0;
        for (let y = 0; y < tileSize; y++) {
          for (let x = 0; x < tileSize; x++) {
            const globalX = tx * tileSize + x;
            const globalY = ty * tileSize + y;
            const idx = (globalY * width + globalX) * 4;
            // Copy the four RGBA bytes
            tileBuffer[bufferOffset++] = png.data[idx];
            tileBuffer[bufferOffset++] = png.data[idx + 1];
            tileBuffer[bufferOffset++] = png.data[idx + 2];
            tileBuffer[bufferOffset++] = png.data[idx + 3];
          }
        }
        // Encode the tile’s coordinate and its raw pixel data (as a hex string)
        const tileHex = tileBuffer.toString('hex');
        const elementString = `${tx},${ty}-${tileHex}`;
        elements.push(elementString);
        tileInfo.push({ tx, ty, index: tileIndex, tileBuffer });
        tileIndex++;
      }
    }
    
    console.error(`Extracted ${elements.length} tile elements from image.`);
    return { elements, png, tileInfo, width, height, tilesAcross, tilesDown, tileSize };
  } catch (err) {
    console.error(`Error reading PNG file ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

// Server mode: set up the PSI server using the extracted image tiles
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
      
      // Handle GET /setup
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
      }
      // Handle POST /request
      else if (req.method === 'POST' && url.pathname === '/request') {
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

// Client mode: perform PSI and then output the final image
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
      headers: {
        'X-Num-Elements': elements.length.toString()
      }
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
      headers: {
        'Content-Type': 'application/octet-stream'
      },
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
      // Retrieve the intersection (an array of indices corresponding to matching tiles)
      const intersection = client.getIntersection(serverSetup, serverResponse);
      console.error(`Intersection contains ${intersection.length} tiles out of ${elements.length}`);
      
      const intersectionSet = new Set(intersection);
      
      // For each tile not in the intersection, set its pixels to white in the image
      for (let i = 0; i < tileInfo.length; i++) {
        if (!intersectionSet.has(i)) {
          const { tx, ty } = tileInfo[i];
          for (let y = 0; y < tileSize; y++) {
            for (let x = 0; x < tileSize; x++) {
              const globalX = tx * tileSize + x;
              const globalY = ty * tileSize + y;
              const idx = (globalY * width + globalX) * 4;
              png.data[idx] = 255;     // Red
              png.data[idx + 1] = 255; // Green
              png.data[idx + 2] = 255; // Blue
              png.data[idx + 3] = 255; // Alpha
            }
          }
        }
      }
      console.error(`Set ${tileInfo.length - intersection.length} non-intersecting tiles to white.`);
      
      // Write the modified image to file (output written as "psi_output.png")
      const outputBuffer = PNG.sync.write(png);
      const outputPath = path.join(process.cwd(), 'psi_output.png');
      fs.writeFileSync(outputPath, outputBuffer);
      console.error(`Final image written to ${outputPath}`);
    } else {
      // If not revealing the intersection, just output the intersection size
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
