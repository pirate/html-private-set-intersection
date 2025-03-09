#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { program } = require('commander');
const PSI = require('@openmined/psi.js');

// CLI options
program
  .option('-s, --server', 'Run as server')
  .option('-c, --client <host:port>', 'Run as client and connect to server')
  .option('-h, --host <host>', 'Host to bind server to', '0.0.0.0')
  .option('-p, --port <port>', 'Port to bind server to', '5995')
  .option('-f, --file <path>', 'Path to file with data for PSI')
  .option('--fpr <rate>', 'False positive rate (default: 0.001)', '0.001')
  .option('--reveal-intersection', 'Reveal the actual intersection instead of just the size')
  .option('--highlight', 'Output the full file with intersection lines highlighted in green, non-intersection in red')
  .parse(process.argv);

const options = program.opts();

// Validate required options
if (!options.file) {
  console.error('Error: --file is required');
  process.exit(1);
}

if (!options.server && !options.client) {
  console.error('Error: Either --server or --client must be specified');
  process.exit(1);
}

// Read and process the file
function readFileLines(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    // Split by newlines and filter out empty lines
    return content.split(/\r?\n/).filter(line => line.trim().length > 0);
  } catch (err) {
    console.error(`Error reading file ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

// Run as server
async function runServer() {
  const psi = await PSI();
  const fileLines = readFileLines(options.file);
  const revealIntersection = !!options.revealIntersection;
  const server = psi.server.createWithNewKey(revealIntersection);
  
  console.error(`Server started on ${options.host}:${options.port}`);
  console.error(`Loaded ${fileLines.length} elements from file`);
  console.error(`Reveal intersection: ${revealIntersection}`);

  // Create HTTP server to handle PSI protocol
  const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/setup') {
      // Step 1: Send the server setup to the client
      const numClientElements = parseInt(req.headers['x-num-elements'] || '100', 10);
      const fpr = parseFloat(options.fpr);
      
      console.error(`Creating setup for client with ${numClientElements} elements (FPR: ${fpr})`);
      
      const serverSetup = server.createSetupMessage(
        fpr,
        numClientElements,
        fileLines,
        psi.dataStructure.GCS
      );
      
      const serializedSetup = Buffer.from(serverSetup.serializeBinary());
      
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': serializedSetup.length
      });
      res.end(serializedSetup);
      
    } else if (req.method === 'POST' && req.url === '/request') {
      // Step 2: Process client request
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      
      req.on('end', () => {
        const requestData = Buffer.concat(chunks);
        
        try {
          const clientRequest = psi.request.deserializeBinary(requestData);
          const serverResponse = server.processRequest(clientRequest);
          const serializedResponse = Buffer.from(serverResponse.serializeBinary());
          
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': serializedResponse.length
          });
          res.end(serializedResponse);
          
        } catch (error) {
          console.error('Error processing client request:', error);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error processing request');
        }
      });
      
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
  
  // Start the server
  httpServer.listen(parseInt(options.port, 10), options.host);
  httpServer.on('error', (error) => {
    console.error(`Server error: ${error.message}`);
    process.exit(1);
  });
}

// Run as client
async function runClient() {
  const [host, port] = options.client.split(':');
  const targetPort = parseInt(port || '5995', 10);
  const fileLines = readFileLines(options.file);
  const revealIntersection = !!options.revealIntersection;
  
  console.error(`Connecting to server at ${host}:${targetPort}`);
  console.error(`Loaded ${fileLines.length} elements from file`);
  console.error(`Reveal intersection: ${revealIntersection}`);
  
  try {
    const psi = await PSI();
    const client = psi.client.createWithNewKey(revealIntersection);
    
    // Step 1: Get the server setup
    const setupResponse = await new Promise((resolve, reject) => {
      const req = http.request({
        host,
        port: targetPort,
        path: '/setup',
        method: 'GET',
        headers: {
          'X-Num-Elements': fileLines.length.toString()
        }
      }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(Buffer.concat(chunks));
          } else {
            reject(new Error(`HTTP Error: ${res.statusCode}`));
          }
        });
      });
      
      req.on('error', reject);
      req.end();
    });
    
    // Step 2: Create and send the client request
    const clientRequest = client.createRequest(fileLines);
    const serializedRequest = clientRequest.serializeBinary();
    
    const responseData = await new Promise((resolve, reject) => {
      const req = http.request({
        host,
        port: targetPort,
        path: '/request',
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': serializedRequest.length
        }
      }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(Buffer.concat(chunks));
          } else {
            reject(new Error(`HTTP Error: ${res.statusCode}`));
          }
        });
      });
      
      req.on('error', reject);
      req.write(serializedRequest);
      req.end();
    });
    
    // Step 3: Process the server's response
    const serverSetup = psi.serverSetup.deserializeBinary(setupResponse);
    const serverResponse = psi.response.deserializeBinary(responseData);
    
    if (revealIntersection) {
      // Get the actual intersection
      const intersection = client.getIntersection(serverSetup, serverResponse);
      
      // Create a map of the original elements with their indices in the original file
      const originalElementsWithIndex = fileLines.map((line, index) => ({ line, originalIndex: index }));
      
      // Create a set of indices that are in the intersection
      const indexSet = new Set(intersection);
      
      if (options.highlight) {
        // ANSI color codes
        const GREEN = '\x1b[32m';
        const RED = '\x1b[31m';
        const RESET = '\x1b[0m';
        
        // Output the full file with highlighted lines
        fileLines.forEach((line, index) => {
          const isInIntersection = indexSet.has(index);
          const color = isInIntersection ? GREEN : RED;
          console.log(`${color}${line}${RESET}`);
        });
        
        console.error(`Found ${intersection.length} elements in the intersection (green)`);
      } else {
        // Filter to only include elements in the intersection
        const intersectionElements = originalElementsWithIndex
          .filter(item => indexSet.has(item.originalIndex))
          // Sort by original index to maintain original file order
          .sort((a, b) => a.originalIndex - b.originalIndex)
          .map(item => item.line);
        
        // Output the intersection elements
        console.log(intersectionElements.join('\n'));
        console.error(`Found ${intersectionElements.length} elements in the intersection`);
      }
    } else {
      // Get only the size of the intersection
      const intersectionSize = client.getIntersectionSize(serverSetup, serverResponse);
      console.error(`Intersection size: ${intersectionSize}`);
      console.log(`Intersection size: ${intersectionSize}`);
    }
    
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
