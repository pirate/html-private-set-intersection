#!/usr/bin/env bun
const fs = require('fs');
const path = require('path');
const os = require('os');
const { program } = require('commander');
const PSI = require('@openmined/psi.js');
const { PNG } = require('pngjs');

// CLI options
program
  .option('-s, --server', 'Run as server')
  .option('-c, --client <host:port>', 'Run as client and connect to server')
  .option('-h, --host <host>', 'Host to bind server to', '0.0.0.0')
  .option('-p, --port <port>', 'Port to bind server to', '5995')
  .option('-f, --file <path>', 'Path to PNG file for PSI')
  .option('--fpr <rate>', 'False positive rate (default: 0.001)', '0.001')
  .option('--reveal-intersection', 'Reveal the actual intersection image (non-intersecting pixels set to white)')
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

// Temporary directory for tiles (both original and intersection)
const tmpDir = path.join(os.tmpdir(), 'psi_image_tiles');
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
  console.error(`Created temporary directory ${tmpDir}`);
}

/**
 * Tiles a PNG image into tiles of given dimensions.
 * For each tile, a new PNG is created, saved to tmpDir,
 * and an array of PSI elements is computed for that tile.
 *
 * Returns an object:
 *  {
 *    tiles: { "<row>_<col>": { tilePng, elements, filePath } },
 *    numTilesX,
 *    numTilesY,
 *    width, height
 *  }
 */
function tilePngImage(png, tileWidth = 100, tileHeight = 100) {
  const tiles = {};
  const numTilesX = Math.floor(png.width / tileWidth);
  const numTilesY = Math.floor(png.height / tileHeight);
  console.error(`Tiling image (${png.width}x${png.height}) into ${numTilesY} rows x ${numTilesX} cols of ${tileWidth}x${tileHeight} each`);
  for (let tileRow = 0; tileRow < numTilesY; tileRow++) {
    for (let tileCol = 0; tileCol < numTilesX; tileCol++) {
      // Create a new PNG tile
      const tilePng = new PNG({ width: tileWidth, height: tileHeight });
      for (let y = 0; y < tileHeight; y++) {
        for (let x = 0; x < tileWidth; x++) {
          const srcX = tileCol * tileWidth + x;
          const srcY = tileRow * tileHeight + y;
          const srcIdx = (png.width * srcY + srcX) << 2;
          const destIdx = (tileWidth * y + x) << 2;
          tilePng.data[destIdx]     = png.data[srcIdx];
          tilePng.data[destIdx + 1] = png.data[srcIdx + 1];
          tilePng.data[destIdx + 2] = png.data[srcIdx + 2];
          tilePng.data[destIdx + 3] = png.data[srcIdx + 3];
        }
      }
      // Save the tile to the temporary directory
      const tileFileName = path.join(tmpDir, `tile_${tileRow}_${tileCol}.png`);
      fs.writeFileSync(tileFileName, PNG.sync.write(tilePng));
      console.error(`Saved tile ${tileRow}_${tileCol} to ${tileFileName}`);
      
      // Compute PSI elements for this tile.
      // Each element is "x,y:rrggbbaa" (local to the tile)
      const elements = [];
      for (let y = 0; y < tileHeight; y++) {
        for (let x = 0; x < tileWidth; x++) {
          const idx = (tileWidth * y + x) << 2;
          const r = tilePng.data[idx];
          const g = tilePng.data[idx + 1];
          const b = tilePng.data[idx + 2];
          const a = tilePng.data[idx + 3];
          const hex =
            r.toString(16).padStart(2, '0') +
            g.toString(16).padStart(2, '0') +
            b.toString(16).padStart(2, '0') +
            a.toString(16).padStart(2, '0');
          elements.push(`${x},${y}:${hex}`);
        }
      }
      tiles[`${tileRow}_${tileCol}`] = { tilePng, elements, filePath: tileFileName };
    }
  }
  console.error(`Tiling complete: generated ${Object.keys(tiles).length} tiles.`);
  return { tiles, numTilesX, numTilesY, width: png.width, height: png.height };
}

/**
 * Reads a PNG file from disk.
 * Returns a Promise resolving to a PNG object.
 */
function readPngFile(filePath) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(new PNG())
      .on('parsed', function() {
        console.error(`Loaded image ${filePath} (${this.width}x${this.height})`);
        resolve(this);
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}

/**
 * Server-side: Pre-process the image into tiles and store PSI elements for each tile.
 */
async function runServer() {
  const psi = await PSI();
  const revealIntersection = !!options.revealIntersection;
  const png = await readPngFile(options.file);
  // Tile the image
  const { tiles } = tilePngImage(png);
  console.error(`Server: Pre-processed ${Object.keys(tiles).length} tiles.`);
  
  const server = psi.server.createWithNewKey(revealIntersection);
  
  // Start Bun HTTP server; endpoints expect tileRow and tileCol as query parameters.
  const bunServer = Bun.serve({
    port: parseInt(options.port, 10),
    hostname: options.host,
    
    async fetch(req) {
      const url = new URL(req.url);
      const tileRow = url.searchParams.get('tileRow');
      const tileCol = url.searchParams.get('tileCol');
      if (tileRow === null || tileCol === null) {
        return new Response('Tile coordinates missing', { status: 400 });
      }
      const tileKey = `${tileRow}_${tileCol}`;
      const tileData = tiles[tileKey];
      if (!tileData) {
        return new Response('Tile not found', { status: 404 });
      }
      // For this tile, use its PSI elements.
      if (req.method === 'GET' && url.pathname === '/setup') {
        const numClientElements = parseInt(req.headers.get('x-num-elements') || '100', 10);
        const fpr = parseFloat(options.fpr);
        console.error(`Tile ${tileKey}: Creating setup for client with ${numClientElements} elements (FPR: ${fpr})`);
        const serverSetup = server.createSetupMessage(
          fpr,
          numClientElements,
          tileData.elements,
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
          console.error(`Tile ${tileKey}: Error processing client request:`, error);
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

/**
 * Client-side: Pre-process the image into tiles, then for each tile run a PSI exchange,
 * generate an intersection tile (non-intersecting pixels set to white), and finally reassemble
 * the final image from the intersection tiles.
 */
async function runClient() {
  const [host, port] = options.client.split(':');
  const targetPort = parseInt(port || '5995', 10);
  const revealIntersection = !!options.revealIntersection;
  const png = await readPngFile(options.file);
  // Tile the image
  const { tiles, numTilesX, numTilesY, width, height } = tilePngImage(png);
  console.error(`Client: Pre-processed ${Object.keys(tiles).length} tiles.`);
  
  const psi = await PSI();
  
  // We'll store intersection tiles in tmpDir with names "intersection_tile_<row>_<col>.png"
  for (let tileRow = 0; tileRow < numTilesY; tileRow++) {
    for (let tileCol = 0; tileCol < numTilesX; tileCol++) {
      const tileKey = `${tileRow}_${tileCol}`;
      const tileData = tiles[tileKey];
      console.error(`Client: Processing tile ${tileKey}`);
      
      // Create a new PSI client instance for this tile.
      const client = psi.client.createWithNewKey(revealIntersection);
      // Get server setup for this tile
      const setupUrl = `http://${host}:${targetPort}/setup?tileRow=${tileRow}&tileCol=${tileCol}`;
      const setupResponse = await fetch(setupUrl, {
        method: 'GET',
        headers: {
          'X-Num-Elements': tileData.elements.length.toString()
        }
      });
      if (!setupResponse.ok) {
        throw new Error(`HTTP Error for tile ${tileKey}: ${setupResponse.status}`);
      }
      const setupData = await setupResponse.arrayBuffer();
      
      // Create and send client request
      const clientRequest = client.createRequest(tileData.elements);
      const serializedRequest = clientRequest.serializeBinary();
      const requestUrl = `http://${host}:${targetPort}/request?tileRow=${tileRow}&tileCol=${tileCol}`;
      const responseResult = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        body: serializedRequest
      });
      if (!responseResult.ok) {
        throw new Error(`HTTP Error for tile ${tileKey}: ${responseResult.status}`);
      }
      const responseData = await responseResult.arrayBuffer();
      
      // Process PSI response for this tile
      const serverSetup = psi.serverSetup.deserializeBinary(new Uint8Array(setupData));
      const serverResponse = psi.response.deserializeBinary(new Uint8Array(responseData));
      
      if (revealIntersection) {
        // Get the indices of intersecting pixels in this tile.
        const intersection = client.getIntersection(serverSetup, serverResponse);
        console.error(`Tile ${tileKey}: Found ${intersection.length} intersecting pixels out of ${tileData.elements.length}`);
        const intersectionSet = new Set(intersection);
        // Create a new PNG tile for the intersection result.
        const tileWidth = tileData.tilePng.width;
        const tileHeight = tileData.tilePng.height;
        const outputTile = new PNG({ width: tileWidth, height: tileHeight });
        const totalPixels = tileWidth * tileHeight;
        for (let i = 0; i < totalPixels; i++) {
          const srcIdx = i << 2;
          if (intersectionSet.has(i)) {
            // Copy pixel from original tile.
            outputTile.data[srcIdx]     = tileData.tilePng.data[srcIdx];
            outputTile.data[srcIdx + 1] = tileData.tilePng.data[srcIdx + 1];
            outputTile.data[srcIdx + 2] = tileData.tilePng.data[srcIdx + 2];
            outputTile.data[srcIdx + 3] = tileData.tilePng.data[srcIdx + 3];
          } else {
            // Set pixel to white.
            outputTile.data[srcIdx]     = 255;
            outputTile.data[srcIdx + 1] = 255;
            outputTile.data[srcIdx + 2] = 255;
            outputTile.data[srcIdx + 3] = 255;
          }
          if (i % Math.floor(totalPixels / 10) === 0) {
            console.error(`Tile ${tileKey}: Processed ${i} / ${totalPixels} pixels...`);
          }
        }
        const intersectionTileFile = path.join(tmpDir, `intersection_tile_${tileRow}_${tileCol}.png`);
        fs.writeFileSync(intersectionTileFile, PNG.sync.write(outputTile));
        console.error(`Tile ${tileKey}: Intersection tile saved to ${intersectionTileFile}`);
      } else {
        const intersectionSize = client.getIntersectionSize(serverSetup, serverResponse);
        console.error(`Tile ${tileKey}: Intersection size: ${intersectionSize} pixels`);
      }
    }
  }
  
  // Reassemble the final image from intersection tiles.
  if (revealIntersection) {
    console.error(`Client: Assembling final image from intersection tiles...`);
    const finalImage = new PNG({ width, height });
    const tileWidth = 100;
    const tileHeight = 100;
    for (let tileRow = 0; tileRow < numTilesY; tileRow++) {
      for (let tileCol = 0; tileCol < numTilesX; tileCol++) {
        const tileFile = path.join(tmpDir, `intersection_tile_${tileRow}_${tileCol}.png`);
        if (!fs.existsSync(tileFile)) {
          console.error(`Missing intersection tile: ${tileFile}`);
          continue;
        }
        const tileData = PNG.sync.read(fs.readFileSync(tileFile));
        for (let y = 0; y < tileHeight; y++) {
          for (let x = 0; x < tileWidth; x++) {
            const destX = tileCol * tileWidth + x;
            const destY = tileRow * tileHeight + y;
            const destIdx = (finalImage.width * destY + destX) << 2;
            const srcIdx = (tileWidth * y + x) << 2;
            finalImage.data[destIdx]     = tileData.data[srcIdx];
            finalImage.data[destIdx + 1] = tileData.data[srcIdx + 1];
            finalImage.data[destIdx + 2] = tileData.data[srcIdx + 2];
            finalImage.data[destIdx + 3] = tileData.data[srcIdx + 3];
          }
        }
      }
    }
    console.error(`Client: Final image assembly complete. Writing output PNG to stdout.`);
    finalImage.pack().pipe(process.stdout);
  }
}

if (options.server) {
  runServer();
} else if (options.client) {
  runClient();
}
