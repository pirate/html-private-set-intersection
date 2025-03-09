// server.js
import express from 'express';
import http from 'http';
import cors from 'cors';
import { json } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer } from 'ws';

const app = express();
const server = http.createServer(app);
const port = 3001;

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Enable CORS for all routes
app.use(cors());
app.use(json());

// Store active sessions and their WebSocket connections
const sessions = new Map();
const connections = new Map();

// Generate a unique session ID
app.get('/session', (req, res) => {
  const sessionId = uuidv4();
  sessions.set(sessionId, {
    createdAt: Date.now(),
    ip: req.ip
  });
  
  console.log(`Created new session: ${sessionId}`);
  res.status(200).json({ sessionId });
});

// List all active sessions
app.get('/sessions', (req, res) => {
  const activeSessions = [];
  
  for (const [id, session] of sessions.entries()) {
    // Only include sessions created in the last hour
    if (session.createdAt > Date.now() - 60 * 60 * 1000) {
      activeSessions.push({
        id,
        createdAt: session.createdAt
      });
    }
  }
  
  res.status(200).json({ sessions: activeSessions });
});

// Direct message relay for file content
app.post('/relay', (req, res) => {
  const { sourceId, targetId, type, data } = req.body;
  
  if (!sourceId || !targetId) {
    return res.status(400).json({ error: 'Source and target session IDs are required' });
  }
  
  if (!connections.has(targetId)) {
    return res.status(404).json({ error: 'Target session not connected' });
  }
  
  // Send message to target session
  const targetWs = connections.get(targetId);
  targetWs.send(JSON.stringify({
    type,
    sourceId,
    data
  }));
  
  console.log(`Relayed ${type} message from ${sourceId} to ${targetId}`);
  res.status(200).json({ success: true });
});

// Serve a simple status page
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>PSI Signaling Server</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
          h1 { color: #333; }
          .status { padding: 10px; background-color: #f0f8ff; border-radius: 4px; }
          .info { margin-top: 20px; }
        </style>
      </head>
      <body>
        <h1>PSI Signaling Server</h1>
        <div class="status">
          <p>Server is running on port ${port}</p>
          <p>Your IP address: ${req.ip}</p>
        </div>
        <div class="info">
          <p>This is a signaling server for the PSI application.</p>
          <p>Active sessions: ${sessions.size}</p>
          <p>Active WebSocket connections: ${connections.size}</p>
        </div>
      </body>
    </html>
  `);
});

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  let sessionId = null;
  
  // Handle messages from clients
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'register') {
        // Register session ID
        sessionId = data.sessionId;
        connections.set(sessionId, ws);
        console.log(`WebSocket registered for session ${sessionId}`);
        
        // Acknowledge registration
        ws.send(JSON.stringify({
          type: 'registered',
          sessionId
        }));
      }
      else if (data.type === 'relay') {
        // Relay message to target session
        const { targetId, messageType, messageData } = data;
        
        if (connections.has(targetId)) {
          const targetWs = connections.get(targetId);
          targetWs.send(JSON.stringify({
            type: messageType,
            sourceId: sessionId,
            data: messageData
          }));
          
          console.log(`WebSocket relayed ${messageType} from ${sessionId} to ${targetId}`);
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            error: 'Target session not connected'
          }));
        }
      }
    } catch (err) {
      console.error('Error processing WebSocket message:', err);
    }
  });
  
  // Handle disconnection
  ws.on('close', () => {
    if (sessionId) {
      connections.delete(sessionId);
      console.log(`WebSocket disconnected for session ${sessionId}`);
    }
  });
});

// Start the server
server.listen(port, '0.0.0.0', () => {
  console.log(`Signaling server running at http://0.0.0.0:${port}`);
});
