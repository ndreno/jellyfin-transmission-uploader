// File: server.js

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// --- Logging Setup ---
// Basic console logging. Consider using a library like 'winston' or 'pino' for production.
const log = {
  info: (...args) => console.log('[INFO]', ...args),
  debug: (...args) => console.log('[DEBUG]', ...args), // Use for detailed steps
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};
// --- End Logging Setup ---

const app = express();
const port = process.env.PORT || 3000;

// --- Environment Variable Check ---
log.info('--- Configuration ---');
log.info(`PORT: ${port}`);
log.info(`JELLYFIN_SERVER: ${process.env.JELLYFIN_SERVER || "http://localhost:8096 (Default)"}`);
log.info(`TRANSMISSION_URL: ${process.env.TRANSMISSION_URL ? process.env.TRANSMISSION_URL : 'MISSING!'}`);
log.info(`TRANS_USER: ${process.env.TRANS_USER ? 'Set' : 'MISSING!'}`);
log.info(`TRANS_PASS: ${process.env.TRANS_PASS ? 'Set (********)' : 'MISSING!'}`);
if (!process.env.TRANSMISSION_URL || !process.env.TRANS_USER || !process.env.TRANS_PASS) {
    log.error('CRITICAL: Transmission environment variables (TRANSMISSION_URL, TRANS_USER, TRANS_PASS) are not fully set in .env file!');
}
if (!process.env.SESSION_SECRET) {
    log.error('CRITICAL: SESSION_SECRET environment variable is not set! Using a weak default. Generate one and add to .env');
}
log.info('--- End Configuration ---');
// --- End Environment Variable Check ---


const jellyfinServer = process.env.JELLYFIN_SERVER || "http://localhost:8096"

// Configure Multer destination and error handling
const UPLOAD_DIR = 'uploads/';
if (!fs.existsSync(UPLOAD_DIR)){
    log.info(`Creating upload directory: ${UPLOAD_DIR}`);
    fs.mkdirSync(UPLOAD_DIR);
}
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOAD_DIR);
    },
    filename: function (req, file, cb) {
        // Use a unique name to avoid collisions, keep extension
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // Example: Limit file size to 10MB
});


app.use(express.static('public'));
app.use(express.json());

// --- Session Configuration ---
// WARNING: Use a proper session store (e.g., connect-mongo, connect-redis) for production!
// MemoryStore will lose sessions on server restart.
app.use(session({
    cookie: {
        maxAge: 86400000, // 1 day in milliseconds
        // secure: process.env.NODE_ENV === 'production', // Use secure cookies in production (requires HTTPS)
        // httpOnly: true, // Prevents client-side JS from reading the cookie
        // sameSite: 'lax' // Protects against CSRF
    },
    store: new MemoryStore({
        checkPeriod: 86400000 // prune expired entries every 24h
    }),
    resave: false, // Don't save session if unmodified
    saveUninitialized: false, // Don't create session until something stored
    secret: process.env.SESSION_SECRET || 'a-very-weak-secret-key-replace-me' // MUST set in .env!
}));
// --- End Session Configuration ---


// --- Authentication Middleware ---
function requireLogin(req, res, next) {
  log.debug('Checking authentication status...');
  if (req.session && req.session.userId) {
    log.debug(`User authenticated (userId: ${req.session.userId}). Proceeding.`);
    next(); // User is logged in, proceed
  } else {
    log.warn('Authentication required, but user not logged in. Blocking request.');
    res.status(401).json({ error: 'Unauthorized. Please log in first.' }); // User not logged in
  }
}
// --- End Authentication Middleware ---


// Jellyfin login - Now stores user info in session
app.post('/api/login', async (req, res) => {
  log.info('Received POST /api/login');
  const { username, password } = req.body;

  // Basic validation
  if (!username || !password) {
      log.warn('Login attempt with missing username or password.');
      return res.status(400).json({ error: 'Username and password are required.' });
  }

  log.debug(`Attempting Jellyfin login for user: ${username}`);
  const loginUrl = `${jellyfinServer}/Users/AuthenticateByName`;
  log.debug(`Jellyfin Auth URL: ${loginUrl}`);

  try {
    const response = await axios.post(loginUrl, {
      Username: username,
      Pw: password,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Emby-Authorization': `MediaBrowser Client="TorrentUploader", Device="WebApp", DeviceId="1", Version="1.0"`
      }
    });
    log.info(`Jellyfin login successful for user: ${username}`);

    // --- Store user info in session on successful login ---
    // Regenerate session ID to prevent session fixation
    req.session.regenerate(function(err) {
        if (err) {
            log.error('Error regenerating session:', err);
            return res.status(500).json({ error: 'Login failed during session setup.' });
        }
        req.session.userId = response.data.User.Id; // Store Jellyfin User ID
        req.session.username = response.data.User.Name; // Store username
        req.session.jellyfinToken = response.data.AccessToken; // Store Jellyfin token (optional)
        log.debug(`User ${req.session.username} (ID: ${req.session.userId}) saved to session.`);

        // Send response *after* session is saved
        res.json({ token: response.data.AccessToken }); // Still return token if client needs it directly
    });
    // --- End storing session ---

  } catch (error) {
    log.error(`Jellyfin authentication failed for user: ${username}`);
    if (error.response) {
      log.error('Error Response Data:', error.response.data);
      log.error('Error Response Status:', error.response.status);
      res.status(error.response.status || 401).json({ error: 'Authentication failed', details: error.response.data });
    } else if (error.request) {
      log.error('Error Request:', error.request);
      res.status(500).json({ error: 'Authentication failed - No response from Jellyfin server' });
    } else {
      log.error('Error Message:', error.message);
      res.status(500).json({ error: 'Authentication failed - Client setup error' });
    }
  }
});

// Endpoint to check login status
app.get('/api/status', (req, res) => {
    if (req.session && req.session.userId) {
        log.debug(`Status check: User ${req.session.username} is logged in.`);
        res.json({ loggedIn: true, username: req.session.username });
    } else {
        log.debug('Status check: User is not logged in.');
        res.json({ loggedIn: false });
    }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
    const username = req.session?.username;
    log.info(`Received POST /api/logout for user: ${username || 'Unknown/Not logged in'}`);
    if (req.session) {
        req.session.destroy(err => {
            if (err) {
                log.error('Error destroying session:', err);
                return res.status(500).json({ error: 'Could not log out.' });
            }
            // Optional: Clear the cookie on the client side too
            // The default cookie name used by express-session is 'connect.sid'
            res.clearCookie('connect.sid');
            log.info(`Session destroyed successfully for user: ${username || 'Unknown'}`);
            res.status(200).json({ message: 'Logged out successfully.' });
        });
    } else {
        res.status(200).json({ message: 'No active session to log out from.' });
    }
});


// Upload and send torrent to Transmission (PROTECTED)
// Apply the requireLogin middleware BEFORE the upload handler
app.post('/api/upload', requireLogin, upload.single('torrent'), async (req, res) => {
  // This code will only run if requireLogin calls next()
  log.info(`Received POST /api/upload request from authenticated user: ${req.session.username}`);

  if (!req.file) {
    log.error('Upload failed: No file received in the request.');
    return res.status(400).json({ error: 'No torrent file uploaded.' });
  }

  const torrentPath = req.file.path;
  log.debug(`File uploaded successfully. Details:`, { /* ... file details ... */ });

  // --- Transmission Credentials Check ---
  const transUrl = process.env.TRANSMISSION_URL;
  const transUser = process.env.TRANS_USER;
  const transPass = process.env.TRANS_PASS;

  if (!transUrl || !transUser || !transPass) {
      log.error('Transmission credentials or URL are missing in environment variables.');
      // Clean up uploaded file if config is bad
      fs.unlink(torrentPath, (err) => {
          if (err) log.error(`Failed to delete temp file ${torrentPath} after config error:`, err);
          else log.debug(`Deleted temp file ${torrentPath} after config error.`);
      });
      return res.status(500).json({ error: 'Server configuration error: Transmission details missing.' });
  }
  // --- End Credentials Check ---

  let sessionId = null;

  try {
    log.debug(`Reading torrent file from path: ${torrentPath}`);
    const torrentData = fs.readFileSync(torrentPath);
    log.debug(`Torrent file read successfully, size: ${torrentData.length} bytes.`);
    const base64Torrent = torrentData.toString('base64');
    log.debug(`Torrent data encoded to base64.`);

    const rpcUrl = `${transUrl}/transmission/rpc`;
    const auth = { username: transUser, password: transPass };

    // --- Step 1: Get Transmission Session ID ---
    log.debug(`Attempting to get Transmission session ID from: ${rpcUrl}`);
    try {
        // Make a preliminary request which is expected to fail with 409 Conflict
        await axios.post(rpcUrl, {}, { auth });
        log.warn('Initial request to Transmission did not return 409, proceeding anyway (unusual).');
    } catch (error) {
        if (error.response && error.response.status === 409) {
            sessionId = error.response.headers['x-transmission-session-id'];
            if (sessionId) {
                log.info(`Successfully obtained Transmission session ID.`);
            } else {
                log.error('Received 409 Conflict from Transmission, but X-Transmission-Session-Id header was MISSING!');
                throw new Error('Failed to get Transmission session ID header despite 409 response.');
            }
        } else {
            log.error('Unexpected error while trying to get Transmission session ID.');
            if (error.response) {
                log.error('Error Response Status:', error.response.status);
                log.error('Error Response Data:', error.response.data);
            } else {
                log.error('Error Message:', error.message);
            }
            throw error; // Re-throw the unexpected error
        }
    }

    if (!sessionId) {
         log.error("Failed to obtain Transmission session ID. Cannot proceed.");
         throw new Error('Failed to communicate with Transmission: Could not get session ID.');
    }

    // --- Step 2: Send Torrent to Transmission ---
    log.debug(`Sending 'torrent-add' request to Transmission: ${rpcUrl}`);
    const payload = {
      method: 'torrent-add',
      arguments: { metainfo: base64Torrent }
    };

    const addResp = await axios.post(rpcUrl, payload, {
      headers: { 'X-Transmission-Session-Id': sessionId },
      auth: auth
    });

    log.info('Successfully sent torrent to Transmission.');
    log.debug('Transmission add response status:', addResp.status);
    log.debug('Transmission add response data:', addResp.data);

    if (addResp.data.result === 'success') {
        log.info('Transmission confirmed torrent addition success.');
        res.json({ result: 'success', details: addResp.data.arguments });
    } else {
        log.warn(`Transmission reported non-success result: ${addResp.data.result}`);
        res.status(400).json({ error: 'Transmission reported an issue adding the torrent.', details: addResp.data });
    }

  } catch (err) {
    log.error('An error occurred during the torrent upload process:');
    if (err.response) {
        log.error('Axios Response Error Status:', err.response.status);
        log.error('Axios Response Error Data:', err.response.data);
        res.status(err.response.status || 500).json({ error: 'Failed to send torrent to Transmission', details: err.response.data });
    } else if (err.request) {
        log.error('Axios Request Error: No response received.', err.request);
        res.status(504).json({ error: 'Failed to send torrent to Transmission: No response' });
    } else {
        log.error('Error Message:', err.message);
        res.status(500).json({ error: 'Internal server error during torrent processing.' });
    }
  } finally {
    // --- Clean up the uploaded file ---
    if (fs.existsSync(torrentPath)) {
        log.debug(`Attempting to delete temporary file: ${torrentPath}`);
        fs.unlink(torrentPath, (unlinkErr) => {
            if (unlinkErr) {
                log.error(`Failed to delete temporary file ${torrentPath}:`, unlinkErr);
            } else {
                log.debug(`Successfully deleted temporary file: ${torrentPath}`);
            }
        });
    } else {
        log.debug(`Temporary file ${torrentPath} was already deleted or never existed.`);
    }
  }
});

app.listen(port, () => {
  log.info(`Server running at http://localhost:${port}`);
});