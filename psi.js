#!/usr/bin/env bun
// ./psi.js --server --file test2a.html --reveal-intersection
// ./psi.js --client node1.local:5995 --file test2b.html --reveal-intersection --highlight

const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const PSI = require('@openmined/psi.js');
const crypto = require('crypto');

// Create a hash-based redaction that is consistent for the same input
function createConsistentRedaction(text, salt = 'psi-redaction-salt-8675309') {
  // Use cache for consistent replacements
  const cacheKey = text;
  if (redactionCache.has(cacheKey)) {
    return redactionCache.get(cacheKey);
  }
  
  // Create a hash of the text + salt using SHA-256
  const hash = crypto.createHash('sha256').update(text + salt).digest('hex');
  
  // Use the hash to generate a pseudorandom sequence of the same length
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  
  // Generate a redaction of the same length as the original text
  for (let i = 0; i < text.length; i++) {
    // Use a different part of the hash for each character to improve randomness
    const hashIndex = i % (hash.length - 1);
    const value = parseInt(hash.substr(hashIndex, 2), 16);
    const randomIndex = value % chars.length;
    result += chars[randomIndex];
  }
  
  // Store in cache for future use
  redactionCache.set(cacheKey, result);
  return result;
}

// Cache for redaction values to ensure consistent replacement
const redactionCache = new Map();

// CLI options
program
  .option('-s, --server', 'Run as server')
  .option('-c, --client <host:port>', 'Run as client and connect to server')
  .option('-h, --host <host>', 'Host to bind server to', '0.0.0.0')
  .option('-p, --port <port>', 'Port to bind server to', '5995')
  .option('-f, --file <path>', 'Path to file with data for PSI')
  .option('--fpr <rate>', 'False positive rate (default: 0.001)', '0.001')
  .option('--reveal-intersection', 'Reveal the actual intersection instead of just the size')
  .option('--highlight', 'Output the full file with intersection elements highlighted in green, non-intersection in red')
  .option('--redact', 'Output the full file with non-intersection elements replaced by X characters of the same length')
  .option('--split <mode>', 'Split mode: "line", "word", or "char" (default: "line")', 'line')
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
function readFileContent(filePath, splitMode) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Split the content based on the specified mode
    switch (splitMode) {
      case 'line':
        // Split by newlines and filter out empty lines
        return {
          elements: content.split(/\r?\n/).filter(line => line.trim().length > 0),
          originalContent: content,
          splitMode
        };
      
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
        
        return {
          elements: wordElements,
          originalContent: content,
          splitMode
        };
      
      case 'char':
        // Split by individual characters, excluding whitespace
        return {
          elements: content.replace(/\s/g, '').split(''),
          originalContent: content,
          splitMode
        };
      
      default:
        console.error(`Invalid split mode: ${splitMode}`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error reading file ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

// Run as server
async function runServer() {
  const psi = await PSI();
  const { elements: fileElements } = readFileContent(options.file, options.split);
  const revealIntersection = !!options.revealIntersection;
  const server = psi.server.createWithNewKey(revealIntersection);
  
  console.error(`Server started on ${options.host}:${options.port}`);
  console.error(`Loaded ${fileElements.length} elements from file using '${options.split}' split mode`);
  console.error(`Reveal intersection: ${revealIntersection}`);

  // Create Bun HTTP server
  const bunServer = Bun.serve({
    port: parseInt(options.port, 10),
    hostname: options.host,
    
    async fetch(req) {
      const url = new URL(req.url);
      
      // Step 1: Send the server setup to the client
      if (req.method === 'GET' && url.pathname === '/setup') {
        const numClientElements = parseInt(req.headers.get('x-num-elements') || '100', 10);
        const fpr = parseFloat(options.fpr);
        
        console.error(`Creating setup for client with ${numClientElements} elements (FPR: ${fpr})`);
        
        const serverSetup = server.createSetupMessage(
          fpr,
          numClientElements,
          fileElements,
          psi.dataStructure.GCS
        );
        
        const serializedSetup = Buffer.from(serverSetup.serializeBinary());
        
        return new Response(serializedSetup, {
          headers: { 'Content-Type': 'application/octet-stream' }
        });
      } 
      // Step 2: Process client request
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

// Run as client
async function runClient() {
  const [host, port] = options.client.split(':');
  const targetPort = parseInt(port || '5995', 10);
  const fileData = readFileContent(options.file, options.split);
  const { elements: fileElements, originalContent, splitMode } = fileData;
  const revealIntersection = !!options.revealIntersection;
  
  console.error(`Connecting to server at ${host}:${targetPort}`);
  console.error(`Loaded ${fileElements.length} elements from file using '${splitMode}' split mode`);
  console.error(`Reveal intersection: ${revealIntersection}`);
  
  try {
    const psi = await PSI();
    const client = psi.client.createWithNewKey(revealIntersection);
    
    // Step 1: Get the server setup
    const setupResponse = await fetch(`http://${host}:${targetPort}/setup`, {
      method: 'GET',
      headers: {
        'X-Num-Elements': fileElements.length.toString()
      }
    });
    
    if (!setupResponse.ok) {
      throw new Error(`HTTP Error: ${setupResponse.status}`);
    }
    
    const setupData = await setupResponse.arrayBuffer();
    
    // Step 2: Create and send the client request
    const clientRequest = client.createRequest(fileElements);
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
      // Get the actual intersection
      const intersection = client.getIntersection(serverSetup, serverResponse);
      
      // Create a map of the original elements with their indices in the original file
      const originalElementsWithIndex = fileElements.map((element, index) => ({ element, originalIndex: index }));
      
      // Create a set of indices that are in the intersection
      const indexSet = new Set(intersection);
      
      if (options.highlight) {
        // ANSI color codes
        const GREEN = '\x1b[32m';
        const RED = '\x1b[31m';
        const RESET = '\x1b[0m';
        
        // Handle different split modes for highlighting
        if (splitMode === 'line') {
          // Output the full file with highlighted lines
          const lines = originalContent.split(/\r?\n/);
          lines.forEach((line, lineIdx) => {
            if (line.trim().length === 0) {
              console.log(''); // Empty line
            } else {
              const elementIdx = lines.slice(0, lineIdx).filter(l => l.trim().length > 0).length;
              const isInIntersection = indexSet.has(elementIdx);
              const color = isInIntersection ? GREEN : RED;
              console.log(`${color}${line}${RESET}`);
            }
          });
        } else if (splitMode === 'word') {
          // For word mode with punctuation as separate tokens
          let result = '';
          let tokenIdx = 0;
          
          // Reconstruct the text with highlighting
          let currentWord = '';
          for (let i = 0; i < originalContent.length; i++) {
            const char = originalContent[i];
            
            if (/[a-zA-Z0-9]/.test(char)) {
              // Build up a word
              currentWord += char;
            } else {
              // Output any accumulated word
              if (currentWord) {
                const isInIntersection = indexSet.has(tokenIdx);
                const color = isInIntersection ? GREEN : RED;
                result += `${color}${currentWord}${RESET}`;
                tokenIdx++;
                currentWord = '';
              }
              
              // Handle whitespace (represented by space token)
              if (/\s/.test(char)) {
                const isInIntersection = indexSet.has(tokenIdx);
                const color = isInIntersection ? GREEN : RED;
                // Don't color-code the actual whitespace character to avoid visual confusion
                result += char;
                tokenIdx++;
              } else {
                // Handle punctuation
                const isInIntersection = indexSet.has(tokenIdx);
                const color = isInIntersection ? GREEN : RED;
                result += `${color}${char}${RESET}`;
                tokenIdx++;
              }
            }
          }
          
          // Output final word if any
          if (currentWord) {
            const isInIntersection = indexSet.has(tokenIdx);
            const color = isInIntersection ? GREEN : RED;
            result += `${color}${currentWord}${RESET}`;
          }
          
          console.log(result);
        } else if (splitMode === 'char') {
          // For character mode, highlight each character
          let result = '';
          let nonSpaceIdx = 0;
          
          for (let i = 0; i < originalContent.length; i++) {
            const char = originalContent[i];
            
            if (/\S/.test(char)) {
              const isInIntersection = indexSet.has(nonSpaceIdx);
              const color = isInIntersection ? GREEN : RED;
              result += `${color}${char}${RESET}`;
              nonSpaceIdx++;
            } else {
              result += char;
            }
          }
          
          console.log(result);
        }
        
        console.error(`Found ${intersection.length} elements in the intersection (green)`);
      } 
      else if (options.redact) {
        // Handle different split modes for redaction
        if (splitMode === 'line') {
          // Output the full file with redacted lines
          const lines = originalContent.split(/\r?\n/);
          lines.forEach((line, lineIdx) => {
            if (line.trim().length === 0) {
              console.log(''); // Empty line
            } else {
              const elementIdx = lines.slice(0, lineIdx).filter(l => l.trim().length > 0).length;
              const isInIntersection = indexSet.has(elementIdx);
              if (isInIntersection) {
                console.log(line);
              } else {
                // Replace with consistent hash-based redaction
                console.log(createConsistentRedaction(line));
              }
            }
          });
        } else if (splitMode === 'word') {
          // For word mode with punctuation as separate tokens
          let result = '';
          let tokenIdx = 0;
          
          // Reconstruct the text with redaction
          let currentWord = '';
          for (let i = 0; i < originalContent.length; i++) {
            const char = originalContent[i];
            
            if (/[a-zA-Z0-9]/.test(char)) {
              // Build up a word
              currentWord += char;
            } else {
              // Output any accumulated word
              if (currentWord) {
                const isInIntersection = indexSet.has(tokenIdx);
                if (isInIntersection) {
                  result += currentWord;
                } else {
                  // Replace with consistent hash-based redaction
                  result += createConsistentRedaction(currentWord);
                }
                tokenIdx++;
                currentWord = '';
              }
              
              // Handle whitespace
              if (/\s/.test(char)) {
                tokenIdx++; // Count the whitespace token
                result += char; // Always keep whitespace as is
              } else {
                // Handle punctuation
                const isInIntersection = indexSet.has(tokenIdx);
                if (isInIntersection) {
                  result += char;
                } else {
                  // Replace punctuation with consistent redaction
                  result += createConsistentRedaction(char);
                }
                tokenIdx++;
              }
            }
          }
          
          // Output final word if any
          if (currentWord) {
            const isInIntersection = indexSet.has(tokenIdx);
            if (isInIntersection) {
              result += currentWord;
            } else {
              // Replace with consistent hash-based redaction
              result += createConsistentRedaction(currentWord);
            }
          }
          
          console.log(result);
        } else if (splitMode === 'char') {
          // For character mode, redact each character
          let result = '';
          let nonSpaceIdx = 0;
          
          for (let i = 0; i < originalContent.length; i++) {
            const char = originalContent[i];
            
            if (/\S/.test(char)) {
              const isInIntersection = indexSet.has(nonSpaceIdx);
              result += isInIntersection ? char : createConsistentRedaction(char);
              nonSpaceIdx++;
            } else {
              result += char; // Keep whitespace
            }
          }
          
          console.log(result);
        }
        
        console.error(`Found ${intersection.length} elements in the intersection (not redacted)`);
      }
      else {
        // Filter to only include elements in the intersection
        const intersectionElements = originalElementsWithIndex
          .filter(item => indexSet.has(item.originalIndex))
          // Sort by original index to maintain original file order
          .sort((a, b) => a.originalIndex - b.originalIndex)
          .map(item => item.element);
        
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
