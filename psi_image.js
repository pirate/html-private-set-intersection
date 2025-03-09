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
  .option('--reveal-intersection', 'Reveal the actual intersection (output final image with non-intersecting tiles replaced by averaged colors)')
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
 * Computes the average color of a tile buffer (assumed to be tileSize×tileSize pixels, 4 bytes per pixel).
 * Returns an object {r, g, b, a}.
 */
function averageTileColor(buffer) {
  let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
  const numPixels = buffer.length / 4;
  for (let i = 0; i < buffer.length; i += 4) {
    sumR += buffer[i];
    sumG += buffer[i + 1];
    sumB += buffer[i + 2];
    sumA += buffer[i + 3];
  }
  return {
    r: Math.round(sumR / numPixels),
    g: Math.round(sumG / numPixels),
    b: Math.round(sumB / numPixels),
    a: Math.round(sumA / numPixels)
  };
}

/**
 * Reads a PNG image and divides it into 5×5 pixel tiles.
 * Returns an object containing:
 * - elements: an array of strings encoding tile coordinates and raw pixel data (for PSI)
 * - png: the parsed PNG image
 * - tileInfo: array of tile metadata objects (tx, ty, index, tileBuffer)
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
    
    for (let ty = 0; ty < tilesDown; ty++) {
      console.error(`Processing tile row ${ty + 1} of ${tilesDown}`);
      for (let tx = 0; tx < tilesAcross; tx++) {
        // Allocate buffer for the tile (5×5 pixels, 4 bytes per pixel)
        const tileBuffer = Buffer.alloc(tileSize * tileSize * 4);
        let bufferOffset = 0;
        for (let y = 0; y < tileSize; y++) {
          for (let x = 0; x < tileSize; x++) {
            const globalX = tx * tileSize + x;
            const globalY = ty * tileSize + y;
            const idx = (globalY * width + globalX) * 4;
            tileBuffer[bufferOffset++] = png.data[idx];
            tileBuffer[bufferOffset++] = png.data[idx + 1];
            tileBuffer[bufferOffset++] = png.data[idx + 2];
            tileBuffer[bufferOffset++] = png.data[idx + 3];
          }
        }
        // Encode the tile's coordinate and its raw pixel data (as a hex string)
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
      // Get the intersection indices corresponding to tileInfo order.
      const intersection = client.getIntersection(serverSetup, serverResponse);
      console.error(`Intersection contains ${intersection.length} tiles out of ${elements.length}`);
      
      const intersectionSet = new Set(intersection);
      
      // For each non-intersecting tile, average the colors of its intersecting neighbors (up, down, left, right)
      for (let i = 0; i < tileInfo.length; i++) {
        if (!intersectionSet.has(i)) {
          const { tx, ty } = tileInfo[i];
          const neighborIndices = [];
          
          if (tx > 0) {
            neighborIndices.push((tx - 1) + ty * tilesAcross);
          }
          if (tx < tilesAcross - 1) {
            neighborIndices.push((tx + 1) + ty * tilesAcross);
          }
          if (ty > 0) {
            neighborIndices.push(tx + (ty - 1) * tilesAcross);
          }
          if (ty < tilesDown - 1) {
            neighborIndices.push(tx + (ty + 1) * tilesAcross);
          }
          
          const neighborColors = [];
          for (const nIndex of neighborIndices) {
            if (intersectionSet.has(nIndex)) {
              neighborColors.push(averageTileColor(tileInfo[nIndex].tileBuffer));
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
              a: Math.round(sumA / neighborColors.length)
            };
          } else {
            avgColor = { r: 255, g: 255, b: 255, a: 255 };
          }
          
          // Fill the non-intersecting tile with the computed average color.
          const { tx: tileX, ty: tileY } = tileInfo[i];
          for (let y = 0; y < tileSize; y++) {
            for (let x = 0; x < tileSize; x++) {
              const globalX = tileX * tileSize + x;
              const globalY = tileY * tileSize + y;
              const idx = (globalY * width + globalX) * 4;
              png.data[idx] = avgColor.r;
              png.data[idx + 1] = avgColor.g;
              png.data[idx + 2] = avgColor.b;
              png.data[idx + 3] = avgColor.a;
            }
          }
        }
      }
      
      console.error(`Processed non-intersecting tiles with neighbor-averaged colors.`);
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
