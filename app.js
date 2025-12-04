require('dotenv').config();

const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcrypt');
const cors = require('cors');

const db = require('./databaseConnection');
const saltRounds = 12;

const db_utils = require('./database/db_utils');  // just for version check / debugging
const db_user = require('./database/users');
const progressDb = require('./database/progress');

const app = express();
const port = process.env.PORT || 3000;

/* ----------------------- SECRET INFORMATION ----------------------------*/
const mongodb_user = process.env.MONGODB_USER;
const mongodb_password = process.env.MONGODB_PASSWORD;
const mongodb_session_secret = process.env.MONGODB_SESSION_SECRET;

const node_session_secret = process.env.NODE_SESSION_SECRET;
console.log('MONGO_SESSION_SECRET =', JSON.stringify(process.env.MONGODB_SESSION_SECRET));
console.log('MONGO_SESSION_SECRET length =', process.env.MONGODB_SESSION_SECRET?.length);
/* ----------------------- END OF SECRET INFORMATION ----------------------*/

// --------------------------- MIDDLEWARE ----------------------------------

app.use(express.json());

// Allow Unity/WebGL (Netlify) + local dev to call the API
const allowedOrigins = [
    'http://localhost:5173',                      // local frontend (if you use it)
    'http://localhost:3000',                      // local testing
    'https://zesty-dolphin-b789bd.netlify.app',   // <-- your Netlify game URL
    process.env.CLIENT_ORIGIN                     // optional extra from env
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow non-browser tools / Unity editor / curl (no Origin header)
        if (!origin) return callback(null, true);

        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        console.log('CORS blocked:', origin);
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// handle preflight nicely (optional but recommended)
app.options('*', cors());

app.use(
    session({
        secret: node_session_secret,
        resave: true,
        saveUninitialized: false,
        store: MongoStore.create({
            mongoUrl: `mongodb+srv://${mongodb_user}:${mongodb_password}@gurvircluster.vjdfpla.mongodb.net/?retryWrites=true&w=majority&appName=GurvirCluster`,
            // crypto: { secret: "gua6MZiDHdHqMLNVUbAr54ZxqTdMjqyBErs7Xc3b4v7NZ0dxwowPdgmyrufNYkP" }
        }),
        cookie: {
            httpOnly: true,
            secure: false,    // set to true when you deploy over HTTPS
            sameSite: 'lax',  // for cross-site with HTTPS use 'none'
        },
    })
);

app.use(express.static('public'));

// --------------------------- HELPERS -------------------------------------
function isStrongPassword(pw) {
    const re = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{10,}$/;
    return re.test(pw);
}

function requireAuth(req, res, next) {
    if (!req.session.userId) {
        console.log("Unauthorized Access!");
        return res.status(401).json({ message: 'Not authenticated' });
    }
    console.log("Authorization Access Granted!");
    next();
}

// --------------------------- ROUTES --------------------------------------

// Simple health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// REGISTER: POST /api/auth/register
// body: { username, password }
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body || {};

        if (!username || !password) {
            return res
                .status(400)
                .json({ message: 'Username and password are required' });
        }

        if (!isStrongPassword(password)) {
            return res.status(400).json({
                message:
                    'Password must be at least 10 chars and include upper, lower, number, and symbol',
            });
        }

        // Checks if user exists
        const existing = await db_user.getUser({ user: username });
        if (existing && existing.length > 0) {
            return res.status(409).json({ message: 'Username already taken' });
        }

        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const success = await db_user.createUser({
            user: username,
            hashedPassword,
        });

        if (!success) {
            return res.status(500).json({ message: 'Error creating user' });
        }


        const user_id = await db_user.getUserId({ user: username });
        req.session.userId = user_id;

        res.status(201).json({
            username,
        });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// LOGIN: POST /api/auth/login
// body: { username, password }
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};

        if (!username || !password) {
            return res
                .status(400)
                .json({ message: 'Username and password are required' });
        }

        const user_db = await db_user.getUser({ user: username });
        console.log(`user_db: ${user_db}`);

        if (!user_db || user_db.length !== 1) {
            console.log('User not found or duplicate rows');
            return res
                .status(401)
                .json({ message: 'Invalid username or password' });
        }

        const user = user_db[0]; // { username, password } where password is hashed
        console.log(`user: ${user}`);

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            console.log('Invalid password');
            return res
                .status(401)
                .json({ message: 'Invalid username or password' });
        }


        const user_id = await db_user.getUserId({ user: username });
        console.log(`user_id: ${user_id}`);
        req.session.userId = user_id;

        res.json({ username: user.username });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET /api/progress  -> return best score + wave it happened on
app.get('/api/progress', requireAuth, async (req, res) => {
    try {
        const user_id = req.session.userId;

        const row = await progressDb.getProgress(user_id);
        console.log('row is', row);

        if (!row) {
            // First time player
            return res.json({
                bestScore: 0,
                bestWave: 1,
            });
        }

        res.json({
            bestScore: row.high_score,
            bestWave: row.max_wave,
        });
    } catch (err) {
        console.error('GET /api/progress error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.post('/api/progress', requireAuth, async (req, res) => {
    try {
        const user_id = req.session.userId;
        const { wave, score } = req.body || {};

        if (typeof wave !== 'number' || typeof score !== 'number') {
            return res.status(400).json({ message: 'wave and score are required numbers' });
        }

        await progressDb.upsertProgress(user_id, wave, score);

        console.log("Successful POST");
        res.json({ ok: true });
    } catch (err) {
        console.error('POST /api/progress error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// WHO AM I: GET /api/auth/me
app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({
        username: req.session.username,
    });
});

// LOGOUT: POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
    if (!req.session) {
        return res.json({ message: 'Already logged out' });
    }

    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
            return res.status(500).json({ message: 'Failed to log out' });
        }
        res.clearCookie('connect.sid');
        res.json({ message: 'Logged out' });
    });
});

// 404 handler for API
app.use((req, res) => {
    res.status(404).json({ message: 'Not found' });
});

/* ----------------------- START SERVER -----------------------------------*/

app.listen(port, () => {
    console.log('API listening on port ' + port);
    console.log('http://localhost:' + port);
});