#!/usr/bin/env bun
const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const PSI = require('@openmined/psi.js');
const { PNG } = require('pngjs');

// --- Helper: Zero-pad a number as a string ---
function pad(num, len) {
  return String(num).padStart(len, '0');
}

// --- Progress Bar Helper ---
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

// --- CLI Options ---
program
  .option('-s, --server', 'Run as server')
  .option('-c, --client <host:port>', 'Run as client and connect to server')
  .option('-h, --host <host>', 'Host to bind server to', '0.0.0.0')
  .option('-p, --port <port>', 'Port to bind server to', '5995')
  .option('-f, --file <path>', 'Path to PNG image file for PSI')
  .option('--tile-size <number>', 'Tile size (width and height in pixels)', '5')
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
 * Reads a PNG image and divides it into tiles of arbitrary size.
 *
 * For PSI, each element is constructed as a fixed‑width string:
 *
 *    pad(tx,4) + pad(ty,4) + (for each pixel: pad(R,3)+pad(G,3)+pad(B,3))
 *
 * For example, a tile at (1440,900) with pixels such as (255,255,255),(0,0,0), …
 * becomes a string like:
 *
 *    "014400090025525525500000000000100100100..."
 *
 * Returns an object containing:
 * - elements: array of PSI elements (strings)
 * - png: the parsed PNG image (with RGBA data preserved)
 * - tileInfo: array of tile metadata objects { tx, ty, index }
 * - width, height: image dimensions
 * - tilesAcross, tilesDown: number of tiles horizontally and vertically
 * - tileSize: the tile size (from CLI)
 */
function readImageTiles(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    const png = PNG.sync.read(data);
    const width = png.width;
    const height = png.height;
    console.error(`Loaded image ${filePath} with dimensions ${width}×${height}`);
    
    const tileSize = parseInt(options.tileSize, 10) || 5;
    const tilesAcross = Math.floor(width / tileSize);
    const tilesDown = Math.floor(height / tileSize);
    const totalTiles = tilesAcross * tilesDown;
    console.error(`Dividing image into ${tilesAcross} tiles across and ${tilesDown} tiles down (total ${totalTiles} tiles) with tile size ${tileSize}px`);
    
    const elements = [];
    const tileInfo = [];
    let tileIndex = 0;
    
    for (let ty = 0; ty < tilesDown; ty++) {
      for (let tx = 0; tx < tilesAcross; tx++) {
        let elementStr = pad(tx, 4) + pad(ty, 4);
        for (let y = 0; y < tileSize; y++) {
          for (let x = 0; x < tileSize; x++) {
            const globalX = tx * tileSize + x;
            const globalY = ty * tileSize + y;
            const idx = (globalY * width + globalX) * 4;
            // Append R, G, B each as a 3-digit number.
            elementStr += pad(png.data[idx], 3) +
                          pad(png.data[idx + 1], 3) +
                          pad(png.data[idx + 2], 3);
          }
        }
        elements.push(elementStr);
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
 * Computes the average color of a tile from the PNG image.
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

/**
 * Runs an array of async functions with a concurrency limit.
 */
async function runWithConcurrency(funcs, limit) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < funcs.length) {
      const currentIndex = index;
      index++;
      results[currentIndex] = await funcs[currentIndex]();
    }
  }
  const workers = [];
  for (let i = 0; i < limit; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/* ================== SERVER CODE ================== */
// Precompute the entire PSI set for the server's image at startup.
let serverElements, serverTileInfo, serverPNG, serverImageWidth;
if (options.server) {
  const { elements, png, tileInfo, width, height, tilesAcross, tilesDown, tileSize } = readImageTiles(options.file);
  serverElements = elements;
  serverTileInfo = tileInfo;
  serverPNG = png;
  serverImageWidth = width;
  
  console.error(`Server precomputed ${elements.length} PSI elements for file ${options.file} using tile size ${tileSize}`);
  
  // Start the Bun server.
  // Now, instead of a /setup endpoint, the server only handles individual tile requests:
  // POST /get_tile_intersection?file=input_image.png&tile_idx=45
  const bunServer = Bun.serve({
    port: parseInt(options.port, 10),
    hostname: options.host,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/get_tile_intersection') {
        const tileIdx = parseInt(url.searchParams.get('tile_idx') || '-1', 10);
        if (tileIdx < 0 || tileIdx >= serverElements.length) {
          return new Response('Invalid tile index', { status: 400 });
        }
        // Read the client's PSI element from the request body.
        const clientTile = await req.text();
        if (clientTile === serverElements[tileIdx]) {
          // If matched, retrieve the raw tile bytes from the image.
          const { tx, ty } = serverTileInfo[tileIdx];
          const tileSize = parseInt(options.tileSize, 10) || 5;
          const tileBuffer = Buffer.alloc(tileSize * tileSize * 4);
          let offset = 0;
          for (let y = 0; y < tileSize; y++) {
            for (let x = 0; x < tileSize; x++) {
              const globalX = tx * tileSize + x;
              const globalY = ty * tileSize + y;
              const idx = (globalY * serverImageWidth + globalX) * 4;
              tileBuffer[offset++] = serverPNG.data[idx];
              tileBuffer[offset++] = serverPNG.data[idx + 1];
              tileBuffer[offset++] = serverPNG.data[idx + 2];
              tileBuffer[offset++] = serverPNG.data[idx + 3];
            }
          }
          return new Response(tileBuffer, {
            headers: { 'Content-Type': 'application/octet-stream' }
          });
        } else {
          return new Response(null, { status: 204 });
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

/* ================== CLIENT CODE ================== */
if (options.client) {
  (async () => {
    // The client uses the same shared parameters.
    const { elements, png, tileInfo, width, height, tilesAcross, tilesDown, tileSize } = readImageTiles(options.file);
    console.error(`Client loaded ${elements.length} tile elements from image ${options.file} using tile size ${tileSize}`);
    
    const [host, port] = options.client.split(':');
    const targetPort = parseInt(port || '5995', 10);
    
    // For each tile, the client sends a POST request to /get_tile_intersection.
    const totalTiles = elements.length;
    const tileFunctions = [];
    for (let i = 0; i < totalTiles; i++) {
      tileFunctions.push(async () => {
        const url = `http://${host}:${targetPort}/get_tile_intersection?file=${encodeURIComponent(options.file)}&tile_idx=${i}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: elements[i]
        });
        if (res.status === 200) {
          const tileBytes = await res.arrayBuffer();
          return { idx: i, intersect: true, tileBytes: Buffer.from(tileBytes) };
        } else {
          return { idx: i, intersect: false };
        }
      });
    }
    
    // Process requests with a concurrency limit (10 at a time).
    const concurrencyLimit = 10;
    const results = await runWithConcurrency(tileFunctions, concurrencyLimit);
    
    // Update the client's PNG data for intersecting tiles.
    const intersectionSet = new Set();
    for (const r of results) {
      if (r.intersect) {
        intersectionSet.add(r.idx);
        const { tx, ty } = tileInfo[r.idx];
        let offset = 0;
        for (let y = 0; y < tileSize; y++) {
          for (let x = 0; x < tileSize; x++) {
            const globalX = tx * tileSize + x;
            const globalY = ty * tileSize + y;
            const idx = (globalY * width + globalX) * 4;
            png.data[idx] = r.tileBytes[offset++];
            png.data[idx + 1] = r.tileBytes[offset++];
            png.data[idx + 2] = r.tileBytes[offset++];
            png.data[idx + 3] = r.tileBytes[offset++];
          }
        }
      } else {
        // Mark non-intersecting tile.
        const { tx, ty } = tileInfo[r.idx];
        for (let y = 0; y < tileSize; y++) {
          for (let x = 0; x < tileSize; x++) {
            const globalX = tx * tileSize + x;
            const globalY = ty * tileSize + y;
            const idx = (globalY * width + globalX) * 4;
            png.data[idx] = 0;
            png.data[idx + 1] = 0;
            png.data[idx + 2] = 0;
            png.data[idx + 3] = 0;
          }
        }
      }
      printProgressBar(r.idx + 1, totalTiles, "Tile intersection progress:");
    }
    
    console.error(`Total intersection: ${intersectionSet.size} tiles out of ${totalTiles}`);
    
    // --- Smoothing Pass ---
    for (let i = 0; i < tileInfo.length; i++) {
      const { tx, ty } = tileInfo[i];
      const globalIdx = ((ty * tileSize) * width + tx * tileSize) * 4;
      if (png.data[globalIdx + 3] !== 255) {
        const neighborCoords = [];
        if (tx > 0) neighborCoords.push({ tx: tx - 1, ty });
        if (tx < tilesAcross - 1) neighborCoords.push({ tx: tx + 1, ty });
        if (ty > 0) neighborCoords.push({ tx, ty: ty - 1 });
        if (ty < tilesDown - 1) neighborCoords.push({ tx, ty: ty + 1 });
        
        const neighborColors = [];
        for (const { tx: ntx, ty: nty } of neighborCoords) {
          const nGlobalIdx = ((nty * tileSize) * width + ntx * tileSize) * 4;
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
    
    console.error("Smoothing complete: non-intersecting tiles replaced with neighbor-averaged colors.");
    const outputBuffer = PNG.sync.write(png);
    const outputPath = path.join(process.cwd(), 'psi_output.png');
    fs.writeFileSync(outputPath, outputBuffer);
    console.error(`Final image written to ${outputPath}`);
    
  })().catch(err => {
    console.error(`Client error: ${err.message}`);
    process.exit(1);
  });
}
