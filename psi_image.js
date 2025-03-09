#!/usr/bin/env bun

const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const PSI = require('@openmined/psi.js');
const sharp = require('sharp');
const os = require('os');

// CLI options
program
  .option('-s, --server', 'Run as server')
  .option('-c, --client <host:port>', 'Run as client and connect to server')
  .option('-h, --host <host>', 'Host to bind server to', '0.0.0.0')
  .option('-p, --port <port>', 'Port to bind server to', '5995')
  .option('-i, --image <path>', 'Path to PNG image for PSI')
  .option('-o, --output <path>', 'Path to output the result image (client only)', 'psi_result.png')
  .option('--fpr <rate>', 'False positive rate (default: 0.001)', '0.001')
  .option('--batch-size <size>', 'Number of pixels to process in a batch (default: 100000)', '10000')
  .option('--max-memory <mb>', 'Maximum memory usage in MB (default: 25% of system RAM)', Math.floor(os.totalmem() * 0.25 / (1024 * 1024)).toString())
  .option('--expose-gc', 'Expose garbage collection for better memory management (run with --expose-gc flag)')
  .parse(process.argv);

const options = program.opts();

// Check if garbage collection is exposed
if (options.exposeGc && !global.gc) {
  console.error('Warning: --expose-gc option was set but the script was not run with --expose-gc flag.');
  console.error('For better memory management, run: node --expose-gc psi_image.js [options]');
}

// Validate required options
if (!options.image) {
  console.error('Error: --image is required');
  process.exit(1);
}

if (!options.server && !options.client) {
  console.error('Error: Either --server or --client must be specified');
  process.exit(1);
}

// Extract pixels from an image and create PSI elements
async function extractPixelsAsElements(imagePath) {
  try {
    console.error(`Reading image: ${imagePath}`);
    
    // Use sharp to load and process the image
    const imageBuffer = await sharp(imagePath)
      .ensureAlpha() // Make sure we have an alpha channel
      .raw() // Get raw pixel data
      .toBuffer({ resolveWithObject: true });
      
    const { data, info } = imageBuffer;
    const { width, height, channels } = info;
    
    console.error(`Image dimensions: ${width}x${height}, channels: ${channels}`);
    
    if (channels !== 4) {
      throw new Error('Expected RGBA image with 4 channels');
    }
    
    // Pre-allocate array for better performance
    const totalPixels = width * height;
    const batchSize = parseInt(options.batchSize, 10);
    
    // Estimate memory usage - each string is approximately 15-20 bytes
    const estimatedPixelMemory = totalPixels * 20; // bytes
    const maxMemory = parseInt(options.maxMemory, 10) * 1024 * 1024; // Convert MB to bytes
    
    console.error(`Total pixels: ${totalPixels.toLocaleString()}`);
    console.error(`Estimated memory required: ${Math.floor(estimatedPixelMemory / (1024 * 1024))} MB`);
    console.error(`Maximum memory allowed: ${Math.floor(maxMemory / (1024 * 1024))} MB`);
    
    // Array to hold all pixel elements
    const pixels = [];
    
    // Performance optimization: log progress per 5% of pixels processed
    const progressStep = Math.max(1, Math.floor(totalPixels / 20));
    console.error('Extracting pixels...');
    
    // Extract pixels in batches to manage memory usage
    for (let i = 0; i < totalPixels; i++) {
      // Log progress
      if (i % progressStep === 0) {
        const percent = Math.floor((i / totalPixels) * 100);
        console.error(`Pixel extraction progress: ${percent}%`);
        
        // Optional: Force garbage collection to free memory if available
        if (global.gc) {
          console.error(`Forcing garbage collection at ${percent}%...`);
          global.gc();
        }
      }
      
      const y = Math.floor(i / width);
      const x = i % width;
      const pixelIndex = i * 4;
      
      const r = data[pixelIndex];
      const g = data[pixelIndex + 1];
      const b = data[pixelIndex + 2];
      const a = data[pixelIndex + 3];
      
      // Use more compact format with periods instead of commas to reduce string size
      // The format "x.y.r.g.b.a" is more efficient than "x,y,r,g,b,a"
      const pixelElement = `${x}.${y}.${r}.${g}.${b}.${a}`;
      pixels.push(pixelElement);
      
      // Optionally yield to event loop occasionally to prevent blocking
      if (i % 1000000 === 0 && i > 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    
    console.error(`Extracted ${pixels.length.toLocaleString()} pixels from image`);
    
    return {
      elements: pixels,
      width,
      height,
      rawData: data
    };
  } catch (err) {
    console.error(`Error processing image ${imagePath}: ${err.message}`);
    process.exit(1);
  }
}

// Run as server
async function runServer() {
  console.error(`Loading PSI library...`);
  const psi = await PSI();
  console.error(`PSI library loaded.`);
  
  console.error(`Extracting pixels from image...`);
  const { elements: imageElements } = await extractPixelsAsElements(options.image);
  console.error(`Creating server instance...`);
  const server = psi.server.createWithNewKey(true); // Always reveal intersection for images
  
  console.error(`Server started on ${options.host}:${options.port}`);
  console.error(`Loaded ${imageElements.length.toLocaleString()} pixel elements from image`);

  // Try to free memory after loading image data
  if (global.gc) {
    console.error('Forcing garbage collection...');
    global.gc();
  }

  // Create Bun HTTP server
  const bunServer = Bun.serve({
    port: parseInt(options.port, 10),
    hostname: options.host,
    
    async fetch(req) {
      const url = new URL(req.url);
      
      // Step 1: Send the server setup to the client
      if (req.method === 'GET' && url.pathname === '/setup') {
        const numClientElements = parseInt(req.headers.get('x-num-elements') || '10000', 10);
        const fpr = parseFloat(options.fpr);
        
        console.error(`Creating setup for client with ${numClientElements.toLocaleString()} elements (FPR: ${fpr})`);
        console.error(`This may take some time for large images...`);
        
        // Progress reporting
        const setupStartTime = Date.now();
        const setupIntervalId = setInterval(() => {
          const elapsedSeconds = Math.floor((Date.now() - setupStartTime) / 1000);
          const elapsedMinutes = Math.floor(elapsedSeconds / 60);
          const remainingSeconds = elapsedSeconds % 60;
          console.error(`Server setup in progress... (${elapsedMinutes}m ${remainingSeconds}s elapsed)`);
          
          // Log memory usage
          const memoryUsage = process.memoryUsage();
          console.error(`Memory usage: RSS=${(memoryUsage.rss / (1024 * 1024)).toFixed(2)}MB, Heap=${(memoryUsage.heapUsed / (1024 * 1024)).toFixed(2)}MB / ${(memoryUsage.heapTotal / (1024 * 1024)).toFixed(2)}MB`);
        }, 10000);
        
        try {
          const serverSetup = server.createSetupMessage(
            fpr,
            numClientElements,
            imageElements,
            psi.dataStructure.GCS
          );
          
          clearInterval(setupIntervalId);
          const setupTime = Math.floor((Date.now() - setupStartTime) / 1000);
          const setupMinutes = Math.floor(setupTime / 60);
          const setupSeconds = setupTime % 60;
          console.error(`Setup created in ${setupMinutes}m ${setupSeconds}s`);
          
          const serializedSetup = Buffer.from(serverSetup.serializeBinary());
          console.error(`Setup serialized, size: ${(serializedSetup.length / (1024 * 1024)).toFixed(2)}MB`);
          
          // Try to free memory after creating setup
          if (global.gc) {
            console.error('Forcing garbage collection...');
            global.gc();
          }
          
          return new Response(serializedSetup, {
            headers: { 'Content-Type': 'application/octet-stream' }
          });
        } catch (error) {
          clearInterval(setupIntervalId);
          console.error(`Error creating setup: ${error.message}`);
          return new Response(`Error creating setup: ${error.message}`, { status: 500 });
        }
      } 
      // Step 2: Process client request
      else if (req.method === 'POST' && url.pathname === '/request') {
        try {
          console.error(`Received client request...`);
          const requestStartTime = Date.now();
          
          const requestData = await req.arrayBuffer();
          console.error(`Processing request of size ${(requestData.byteLength / (1024 * 1024)).toFixed(2)}MB`);
          
          // Progress reporting
          const requestIntervalId = setInterval(() => {
            const elapsedSeconds = Math.floor((Date.now() - requestStartTime) / 1000);
            const elapsedMinutes = Math.floor(elapsedSeconds / 60);
            const remainingSeconds = elapsedSeconds % 60;
            console.error(`Processing request... (${elapsedMinutes}m ${remainingSeconds}s elapsed)`);
            
            // Log memory usage
            const memoryUsage = process.memoryUsage();
            console.error(`Memory usage: RSS=${(memoryUsage.rss / (1024 * 1024)).toFixed(2)}MB, Heap=${(memoryUsage.heapUsed / (1024 * 1024)).toFixed(2)}MB / ${(memoryUsage.heapTotal / (1024 * 1024)).toFixed(2)}MB`);
          }, 10000);
          
          const clientRequest = psi.request.deserializeBinary(new Uint8Array(requestData));
          console.error(`Request deserialized, processing...`);
          
          const serverResponse = server.processRequest(clientRequest);
          
          clearInterval(requestIntervalId);
          const processingTime = Math.floor((Date.now() - requestStartTime) / 1000);
          const processingMinutes = Math.floor(processingTime / 60);
          const processingSeconds = processingTime % 60;
          console.error(`Request processed in ${processingMinutes}m ${processingSeconds}s`);
          
          const serializedResponse = Buffer.from(serverResponse.serializeBinary());
          console.error(`Response serialized, size: ${(serializedResponse.length / (1024 * 1024)).toFixed(2)}MB`);
          
          // Try to free memory after processing
          if (global.gc) {
            console.error('Forcing garbage collection...');
            global.gc();
          }
          
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

// Run as client
async function runClient() {
  const [host, port] = options.client.split(':');
  const targetPort = parseInt(port || '5995', 10);
  const batchSize = parseInt(options.batchSize, 10);
  
  console.error(`Loading PSI library...`);
  const psi = await PSI();
  console.error(`PSI library loaded.`);
  
  console.error(`Extracting pixels from image...`);
  const imageData = await extractPixelsAsElements(options.image);
  const { elements: imageElements, width, height } = imageData;
  
  console.error(`Connecting to server at ${host}:${targetPort}`);
  console.error(`Loaded ${imageElements.length.toLocaleString()} pixel elements from image`);
  
  // Try to free memory after loading image data
  if (global.gc) {
    console.error('Forcing garbage collection...');
    global.gc();
  }
  
  try {
    console.error(`Creating client instance...`);
    const client = psi.client.createWithNewKey(true); // Always reveal intersection for images
    
    // Step 1: Get the server setup
    console.error(`Requesting server setup (this might take a while)...`);
    const setupStartTime = Date.now();
    
    const setupProgressIntervalId = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - setupStartTime) / 1000);
      const elapsedMinutes = Math.floor(elapsedSeconds / 60);
      const remainingSeconds = elapsedSeconds % 60;
      console.error(`Waiting for server setup... (${elapsedMinutes}m ${remainingSeconds}s elapsed)`);
      
      // Log memory usage
      const memoryUsage = process.memoryUsage();
      console.error(`Memory usage: RSS=${(memoryUsage.rss / (1024 * 1024)).toFixed(2)}MB, Heap=${(memoryUsage.heapUsed / (1024 * 1024)).toFixed(2)}MB / ${(memoryUsage.heapTotal / (1024 * 1024)).toFixed(2)}MB`);
    }, 10000);
    
    const setupResponse = await fetch(`http://${host}:${targetPort}/setup`, {
      method: 'GET',
      headers: {
        'X-Num-Elements': imageElements.length.toString()
      }
    });
    
    clearInterval(setupProgressIntervalId);
    
    if (!setupResponse.ok) {
      throw new Error(`HTTP Error: ${setupResponse.status}`);
    }
    
    const setupTime = Math.floor((Date.now() - setupStartTime) / 1000);
    const setupMinutes = Math.floor(setupTime / 60);
    const setupSeconds = setupTime % 60;
    console.error(`Setup received in ${setupMinutes}m ${setupSeconds}s, downloading data...`);
    
    const setupData = await setupResponse.arrayBuffer();
    console.error(`Setup data downloaded, size: ${(setupData.byteLength / (1024 * 1024)).toFixed(2)}MB`);
    
    // Step 2: Create and send the client request
    console.error(`Creating client request...`);
    const requestStartTime = Date.now();
    
    const requestProgressIntervalId = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - requestStartTime) / 1000);
      const elapsedMinutes = Math.floor(elapsedSeconds / 60);
      const remainingSeconds = elapsedSeconds % 60;
      console.error(`Creating client request... (${elapsedMinutes}m ${remainingSeconds}s elapsed)`);
      
      // Log memory usage
      const memoryUsage = process.memoryUsage();
      console.error(`Memory usage: RSS=${(memoryUsage.rss / (1024 * 1024)).toFixed(2)}MB, Heap=${(memoryUsage.heapUsed / (1024 * 1024)).toFixed(2)}MB / ${(memoryUsage.heapTotal / (1024 * 1024)).toFixed(2)}MB`);
    }, 10000);
    
    const clientRequest = client.createRequest(imageElements);
    
    clearInterval(requestProgressIntervalId);
    const requestTime = Math.floor((Date.now() - requestStartTime) / 1000);
    const requestMinutes = Math.floor(requestTime / 60);
    const requestSeconds = requestTime % 60;
    console.error(`Client request created in ${requestMinutes}m ${requestSeconds}s`);
    
    const serializedRequest = clientRequest.serializeBinary();
    console.error(`Request serialized, size: ${(serializedRequest.length / (1024 * 1024)).toFixed(2)}MB`);
    
    // Try to free memory after creating request
    if (global.gc) {
      console.error('Forcing garbage collection...');
      global.gc();
    }
    
    console.error(`Sending request to server...`);
    const responseStartTime = Date.now();
    
    const responseProgressIntervalId = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - responseStartTime) / 1000);
      const elapsedMinutes = Math.floor(elapsedSeconds / 60);
      const remainingSeconds = elapsedSeconds % 60;
      console.error(`Waiting for server response... (${elapsedMinutes}m ${remainingSeconds}s elapsed)`);
      
      // Log memory usage
      const memoryUsage = process.memoryUsage();
      console.error(`Memory usage: RSS=${(memoryUsage.rss / (1024 * 1024)).toFixed(2)}MB, Heap=${(memoryUsage.heapUsed / (1024 * 1024)).toFixed(2)}MB / ${(memoryUsage.heapTotal / (1024 * 1024)).toFixed(2)}MB`);
    }, 10000);
    
    const responseResult = await fetch(`http://${host}:${targetPort}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      body: serializedRequest
    });
    
    clearInterval(responseProgressIntervalId);
    
    if (!responseResult.ok) {
      throw new Error(`HTTP Error: ${responseResult.status}`);
    }
    
    const responseTime = Math.floor((Date.now() - responseStartTime) / 1000);
    const responseMinutes = Math.floor(responseTime / 60);
    const responseSeconds = responseTime % 60;
    console.error(`Response received in ${responseMinutes}m ${responseSeconds}s, downloading data...`);
    
    const responseData = await responseResult.arrayBuffer();
    console.error(`Response data downloaded, size: ${(responseData.byteLength / (1024 * 1024)).toFixed(2)}MB`);
    
    // Try to free memory after receiving response
    if (global.gc) {
      console.error('Forcing garbage collection...');
      global.gc();
    }
    
    // Step 3: Process the server's response
    console.error(`Deserializing server setup...`);
    const serverSetup = psi.serverSetup.deserializeBinary(new Uint8Array(setupData));
    console.error(`Deserializing server response...`);
    const serverResponse = psi.response.deserializeBinary(new Uint8Array(responseData));
    
    // Get the actual intersection
    console.error(`Computing intersection...`);
    const intersectionStartTime = Date.now();
    
    const intersectionProgressIntervalId = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - intersectionStartTime) / 1000);
      const elapsedMinutes = Math.floor(elapsedSeconds / 60);
      const remainingSeconds = elapsedSeconds % 60;
      console.error(`Computing intersection... (${elapsedMinutes}m ${remainingSeconds}s elapsed)`);
      
      // Log memory usage
      const memoryUsage = process.memoryUsage();
      console.error(`Memory usage: RSS=${(memoryUsage.rss / (1024 * 1024)).toFixed(2)}MB, Heap=${(memoryUsage.heapUsed / (1024 * 1024)).toFixed(2)}MB / ${(memoryUsage.heapTotal / (1024 * 1024)).toFixed(2)}MB`);
    }, 10000);
    
    const intersection = client.getIntersection(serverSetup, serverResponse);
    
    clearInterval(intersectionProgressIntervalId);
    const intersectionTime = Math.floor((Date.now() - intersectionStartTime) / 1000);
    const intersectionMinutes = Math.floor(intersectionTime / 60);
    const intersectionSeconds = intersectionTime % 60;
    console.error(`Intersection computed in ${intersectionMinutes}m ${intersectionSeconds}s`);
    console.error(`Intersection size: ${intersection.length.toLocaleString()} pixels`);
    
    // Create a Set from the intersection indices for faster lookup
    console.error(`Creating intersection set...`);
    const intersectionSet = new Set(intersection);
    
    // Use more optimal pixel mapping - create only what we need
    // Use the batch approach to constrain memory usage
    console.error(`Building result image from intersection...`);
    
    // Create a new transparent image buffer
    console.error(`Creating result image buffer...`);
    const resultBuffer = Buffer.alloc(width * height * 4);
    
    // Start with a fully transparent image (already initialized to zeros)
    
    // Process in batches for better memory management
    const totalElements = imageElements.length;
    const batchCount = Math.ceil(totalElements / batchSize);
    console.error(`Processing ${totalElements.toLocaleString()} pixels in ${batchCount} batches of ${batchSize.toLocaleString()} pixels each...`);
    
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
      const startIdx = batchIndex * batchSize;
      const endIdx = Math.min(startIdx + batchSize, totalElements);
      
      console.error(`Processing batch ${batchIndex + 1}/${batchCount} (pixels ${startIdx.toLocaleString()}-${endIdx.toLocaleString()})...`);
      
      // Process this batch of pixels
      let intersectionPixelsInBatch = 0;
      
      for (let i = startIdx; i < endIdx; i++) {
        // Check if this pixel is in the intersection
        if (intersectionSet.has(i)) {
          const pixelData = imageElements[i];
          // Use the updated delimiter from the extraction function
          const [x, y, r, g, b, a] = pixelData.split('.').map(Number);
          const pixelIndex = (y * width + x) * 4;
          
          resultBuffer[pixelIndex] = r;
          resultBuffer[pixelIndex + 1] = g;
          resultBuffer[pixelIndex + 2] = b;
          resultBuffer[pixelIndex + 3] = a;
          
          intersectionPixelsInBatch++;
        }
      }
      
      console.error(`Batch ${batchIndex + 1} complete. Found ${intersectionPixelsInBatch.toLocaleString()} intersection pixels in this batch.`);
      
      // Periodically try to free memory if available
      if (global.gc && batchIndex % 5 === 0) {
        console.error('Forcing garbage collection...');
        global.gc();
      }
    }
    
    // Save the result image using sharp
    console.error(`Saving result image to ${options.output}...`);
    await sharp(resultBuffer, {
      raw: {
        width,
        height,
        channels: 4
      }
    })
    .png()
    .toFile(options.output);
    
    console.error(`Found ${intersection.length.toLocaleString()} pixels in the intersection`);
    console.error(`Saved result image to ${options.output}`);
    console.log(`Intersection size: ${intersection.length} pixels`);
  } catch (error) {
    console.error(`Client error: ${error.message}`);
    process.exit(1);
  }
}

// Main execution
if (options.server) {
  runServer();
} else if (options.client) {
  runClient();
}
