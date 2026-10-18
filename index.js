// ============================================================
// Kuromi Store — self-contained server
// No Firebase. Data lives in ./data/*.json, images in ./images/
// ============================================================

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
// Hosts tell the app which port to use through an environment variable; the
// name varies by provider, so check the common ones before falling back to 3000.
const PORT = process.env.PORT || process.env.SERVER_PORT || process.env.APP_PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const IMAGES_DIR = path.join(__dirname, "images");
const UPLOADS_DIR = path.join(IMAGES_DIR, "uploads");

// Make sure folders exist (first run on a fresh host)
[DATA_DIR, IMAGES_DIR, UPLOADS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const COLLECTIONS = ["products", "orders", "coupons", "feedbacks", "notifications", "categories"];
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]", "utf-8");

// Make sure every collection file + settings file exist
COLLECTIONS.forEach(name => {
    const file = path.join(DATA_DIR, `${name}.json`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, "[]", "utf-8");
});
if (!fs.existsSync(SETTINGS_FILE)) {
    const defaultHash = crypto.scryptSync("123", "default-salt-change-me", 64).toString("hex");
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
        storeStatus: { isOpen: true, deliveredCount: 0 },
        shipping: { cairoGiza: 70, alexandria: 75, other: 85, upper: 120 },
        owner: { user: "admin", passHash: defaultHash, passSalt: "default-salt-change-me" }
    }, null, 2), "utf-8");
}

// ------------------------------------------------------------
// Tiny file-backed "database": readJSON / writeJSON with a
// per-file write queue so two requests can never corrupt a file
// by writing to it at the same time.
// ------------------------------------------------------------
const writeQueues = {};

function queueWrite(file, task) {
    const prev = writeQueues[file] || Promise.resolve();
    const next = prev.then(task, task); // run task even if prev failed
    writeQueues[file] = next.catch(() => {}); // keep the chain alive
    return next;
}

function readJSON(file) {
    const raw = fs.readFileSync(file, "utf-8") || "[]";
    try { return JSON.parse(raw); } catch (e) { return []; }
}

function writeJSON(file, data) {
    return queueWrite(file, () => {
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
        fs.renameSync(tmp, file); // atomic on the same filesystem
    });
}

function collectionFile(name) {
    if (!COLLECTIONS.includes(name)) return null;
    return path.join(DATA_DIR, `${name}.json`);
}

function generateId() {
    // Looks similar enough to a Firestore push id; just needs to be unique.
    return crypto.randomBytes(10).toString("hex");
}

// ------------------------------------------------------------
// Password hashing (built-in Node crypto, no extra dependency).
// The owner password is never stored or sent to the browser in
// plain text — only a salted hash lives on disk, and login is
// checked here on the server.
// ------------------------------------------------------------
function hashPassword(password, salt) {
    salt = salt || crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
    return { salt, hash };
}

function verifyPassword(password, salt, hash) {
    if (!salt || !hash) return false;
    try {
        const check = crypto.scryptSync(String(password), salt, 64).toString("hex");
        return crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(hash, "hex"));
    } catch (e) { return false; }
}

// One-time migration: if settings.owner still has a plain-text `pass` field
// (from before this update, or from the Firestore export), hash it now and
// drop the plain text — the same username/password keep working exactly as
// before, they're just stored safely from this point on.
(function migrateOwnerPassword() {
    const settings = readJSON(SETTINGS_FILE);
    const owner = settings.owner || {};
    if (owner.pass && !owner.passHash) {
        const { salt, hash } = hashPassword(owner.pass);
        settings.owner = { user: owner.user || "admin", passHash: hash, passSalt: salt };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
        console.log("Migrated owner password to a hashed format (same username/password still work).");
    }
})();

// One-time migration: the owner used to be a separate login (settings.owner)
// from customer accounts. Now everyone — owner included — signs in through
// the same screen, distinguished only by `role`. This copies the owner's
// (already-hashed) credentials into users.json as a role:"owner" user, so
// the exact same username/password you already use keeps working.
(function migrateOwnerIntoUsers() {
    const settings = readJSON(SETTINGS_FILE);
    const owner = settings.owner || {};
    if (!owner.user || !owner.passHash) return; // nothing to migrate yet
    const users = readJSON(USERS_FILE);
    const alreadyMigrated = users.some(u => u.role === "owner" && u.username === owner.user);
    if (alreadyMigrated) return;
    users.push({
        id: generateId(), username: owner.user, passHash: owner.passHash, passSalt: owner.passSalt,
        email: "", phone: "", profileImage: "", createdAt: new Date().toISOString(),
        banned: false, suspendedUntil: null, role: "owner"
    });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf-8");
    console.log(`Migrated owner account "${owner.user}" into users.json (role: owner) — same login, one sign-in screen now.`);
})();

// ------------------------------------------------------------
// Middleware
// ------------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: "15mb" })); // generous limit: base64 image uploads go through here
app.use("/images", express.static(IMAGES_DIR, { maxAge: "7d" }));

// ------------------------------------------------------------
// Settings: storeStatus / shipping / owner (object, not a list)
// IMPORTANT: these must be registered BEFORE the generic
// /api/:collection(/:id) routes below — otherwise Express would
// match "/api/settings/storeStatus" against the generic
// "/api/:collection/:id" pattern first (since route matching is
// first-registered-wins), and "settings" isn't in COLLECTIONS, so
// every settings request would 404 before ever reaching these.
// ------------------------------------------------------------

app.get("/api/settings/:name", (req, res) => {
    // The owner's credentials are never sent to the browser. Login is
    // checked server-side via POST /api/login instead.
    if (req.params.name === "owner") return res.status(403).json({ error: "Forbidden" });
    const settings = readJSON(SETTINGS_FILE);
    res.json(settings[req.params.name] || null);
});

app.put("/api/settings/:name", async (req, res) => {
    const settings = readJSON(SETTINGS_FILE);
    const incoming = { ...req.body };
    if (req.params.name === "owner" && incoming.pass) {
        // Hash the new password here; never store or echo back plain text.
        const { salt, hash } = hashPassword(incoming.pass);
        delete incoming.pass;
        incoming.passHash = hash;
        incoming.passSalt = salt;
    }
    settings[req.params.name] = { ...(settings[req.params.name] || {}), ...incoming };
    await writeJSON(SETTINGS_FILE, settings);
    const safeResult = { ...settings[req.params.name] };
    if (req.params.name === "owner") { delete safeResult.passHash; delete safeResult.passSalt; }
    res.json(safeResult);
});

// POST /api/login  body: { user, pass } -> { ok: true|false }
// The only way to check the owner credentials — the password itself
// never leaves the server.
app.post("/api/login", (req, res) => {
    const { user, pass } = req.body || {};
    const settings = readJSON(SETTINGS_FILE);
    const owner = settings.owner || {};
    const userOk = owner.user && owner.user === user;
    const passOk = verifyPassword(pass, owner.passSalt, owner.passHash);
    res.json({ ok: !!(userOk && passOk) });
});

// One-time migration: products used to carry a free-text `category` string.
// Categories are now real records (data/categories.json) and each product
// points at one via `categoryId`. This converts any leftover text categories
// into real ones (matched case-insensitively) and links the products.
(function migrateTextCategories() {
    const productsFile = path.join(DATA_DIR, "products.json");
    const categoriesFile = path.join(DATA_DIR, "categories.json");
    if (!fs.existsSync(categoriesFile)) fs.writeFileSync(categoriesFile, "[]", "utf-8");
    const products = readJSON(productsFile);
    const categories = readJSON(categoriesFile);
    let changed = false;
    products.forEach(p => {
        const text = typeof p.category === "string" ? p.category.trim() : "";
        if (!p.categoryId && text) {
            let cat = categories.find(c => c.name.toLowerCase() === text.toLowerCase());
            if (!cat) { cat = { id: generateId(), name: text, createdAt: new Date().toISOString() }; categories.push(cat); }
            p.categoryId = cat.id;
            changed = true;
        }
        if ("category" in p) { delete p.category; changed = true; }
    });
    if (changed) {
        fs.writeFileSync(productsFile, JSON.stringify(products, null, 2), "utf-8");
        fs.writeFileSync(categoriesFile, JSON.stringify(categories, null, 2), "utf-8");
        console.log(`Migrated text categories into ${categories.length} real categories.`);
    }
})();

// ------------------------------------------------------------
// User accounts: everyone (owner included) is a row in users.json now,
// distinguished by `role`: "owner" or "client". Passwords are hashed the
// same way everywhere. A logged-in user gets a random session token good
// for 15 days (kept in memory only — a server restart logs everyone out,
// which is an acceptable trade-off for how simple this keeps things). The
// token is sent as:
//   Authorization: Bearer <token>
// ------------------------------------------------------------
const SESSION_LIFETIME_MS = 15 * 24 * 60 * 60 * 1000; // 15 days
const sessions = new Map(); // token -> { userId, expiresAt }

function sanitizeUser(u) {
    if (!u) return null;
    const { passHash, passSalt, ...safe } = u;
    return safe;
}

function createSession(userId) {
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, { userId, expiresAt: Date.now() + SESSION_LIFETIME_MS });
    return token;
}

function getUserFromRequest(req) {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token || !sessions.has(token)) return null;
    const session = sessions.get(token);
    if (session.expiresAt < Date.now()) { sessions.delete(token); return null; } // expired after 15 days
    const users = readJSON(USERS_FILE);
    return users.find(u => u.id === session.userId) || null;
}

// POST /api/users/signup  body: { username, password, email, phone }
app.post("/api/users/signup", async (req, res) => {
    const { username, password, email, phone } = req.body || {};
    if (!username || !password || !email || !phone) {
        return res.status(400).json({ error: "username, password, email and phone are all required." });
    }
    const users = readJSON(USERS_FILE);
    if (users.some(u => u.username.toLowerCase() === String(username).toLowerCase())) {
        return res.status(409).json({ error: "That username is already taken." });
    }
    const { salt, hash } = hashPassword(password);
    const user = {
        id: generateId(), username, passHash: hash, passSalt: salt,
        email, phone, profileImage: "", createdAt: new Date().toISOString(),
        banned: false, suspendedUntil: null, role: "client"
    };
    users.push(user);
    await writeJSON(USERS_FILE, users);
    const token = createSession(user.id);
    res.json({ token, user: sanitizeUser(user) });
});

// POST /api/users/login  body: { username, password }
app.post("/api/users/login", (req, res) => {
    const { username, password } = req.body || {};
    const users = readJSON(USERS_FILE);
    const user = users.find(u => u.username.toLowerCase() === String(username || "").toLowerCase());
    if (!user) return res.status(401).json({ error: "Invalid username or password." });
    if (user.banned) return res.status(403).json({ error: "This account has been banned." });
    if (user.suspendedUntil && new Date(user.suspendedUntil) > new Date()) {
        return res.status(403).json({ error: `This account is suspended until ${new Date(user.suspendedUntil).toLocaleString()}.` });
    }
    if (!verifyPassword(password, user.passSalt, user.passHash)) {
        return res.status(401).json({ error: "Invalid username or password." });
    }
    const token = createSession(user.id);
    res.json({ token, user: sanitizeUser(user) });
});

// GET /api/users/me  (Authorization: Bearer <token>)
app.get("/api/users/me", (req, res) => {
    const user = getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: "Not signed in." });
    res.json(sanitizeUser(user));
});

// PUT /api/users/me  (Authorization: Bearer <token>) — profile photo / email / phone
app.put("/api/users/me", async (req, res) => {
    const current = getUserFromRequest(req);
    if (!current) return res.status(401).json({ error: "Not signed in." });
    const users = readJSON(USERS_FILE);
    const idx = users.findIndex(u => u.id === current.id);
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    const allowed = ["profileImage", "email", "phone"];
    allowed.forEach(field => { if (req.body[field] !== undefined) users[idx][field] = req.body[field]; });
    await writeJSON(USERS_FILE, users);
    res.json(sanitizeUser(users[idx]));
});

// ---- Owner-only account management ---------------------------------------
// The Users tab holds every customer's email and phone number, so these routes
// require the owner's session token (Authorization: Bearer <token>).
function requireOwner(req, res) {
    const user = getUserFromRequest(req);
    if (!user) { res.status(401).json({ error: "Not signed in." }); return null; }
    if (user.role !== "owner") { res.status(403).json({ error: "Owner access required." }); return null; }
    return user;
}
// Finds the account an admin action targets. The owner's own account can be
// listed but never suspended, banned or deleted (no locking yourself out).
function findManageableUser(req, res, users) {
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) { res.status(404).json({ error: "Not found" }); return -1; }
    if (users[idx].role === "owner") { res.status(400).json({ error: "The owner account can't be suspended, banned or deleted." }); return -1; }
    return idx;
}

// GET /api/users  -> every account, owner included (owner dashboard "Users" tab)
app.get("/api/users", (req, res) => {
    if (!requireOwner(req, res)) return;
    res.json(readJSON(USERS_FILE).map(sanitizeUser));
});

// GET /api/top-clients -> the 3 accounts with the most completed ("done") orders.
// Public on purpose (the home page shows it), so it only ever returns the
// display name, avatar and count — never email, phone or ids.
app.get("/api/top-clients", (req, res) => {
    const orders = readJSON(path.join(DATA_DIR, "orders.json"));
    const users = readJSON(USERS_FILE);
    const counts = {};
    orders.forEach(o => { if (o.status === "done" && o.userId) counts[o.userId] = (counts[o.userId] || 0) + 1; });
    const top = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([id, count]) => { const u = users.find(x => x.id === id); return u ? { username: u.username, profileImage: u.profileImage || "", count } : null; })
        .filter(Boolean)
        .slice(0, 3);
    res.json(top);
});

// PUT /api/users/:id/suspend   body: { days }
app.put("/api/users/:id/suspend", async (req, res) => {
    if (!requireOwner(req, res)) return;
    const days = Number(req.body?.days) || 1;
    const users = readJSON(USERS_FILE);
    const idx = findManageableUser(req, res, users); if (idx === -1) return;
    users[idx].suspendedUntil = new Date(Date.now() + days * 86400000).toISOString();
    await writeJSON(USERS_FILE, users);
    res.json(sanitizeUser(users[idx]));
});

// PUT /api/users/:id/unsuspend
app.put("/api/users/:id/unsuspend", async (req, res) => {
    if (!requireOwner(req, res)) return;
    const users = readJSON(USERS_FILE);
    const idx = findManageableUser(req, res, users); if (idx === -1) return;
    users[idx].suspendedUntil = null;
    await writeJSON(USERS_FILE, users);
    res.json(sanitizeUser(users[idx]));
});

// PUT /api/users/:id/ban
app.put("/api/users/:id/ban", async (req, res) => {
    if (!requireOwner(req, res)) return;
    const users = readJSON(USERS_FILE);
    const idx = findManageableUser(req, res, users); if (idx === -1) return;
    users[idx].banned = true;
    await writeJSON(USERS_FILE, users);
    res.json(sanitizeUser(users[idx]));
});

// PUT /api/users/:id/unban
app.put("/api/users/:id/unban", async (req, res) => {
    if (!requireOwner(req, res)) return;
    const users = readJSON(USERS_FILE);
    const idx = findManageableUser(req, res, users); if (idx === -1) return;
    users[idx].banned = false;
    await writeJSON(USERS_FILE, users);
    res.json(sanitizeUser(users[idx]));
});

// DELETE /api/users/:id
app.delete("/api/users/:id", async (req, res) => {
    if (!requireOwner(req, res)) return;
    const users = readJSON(USERS_FILE);
    const idx = findManageableUser(req, res, users); if (idx === -1) return;
    users.splice(idx, 1);
    await writeJSON(USERS_FILE, users);
    sessions.forEach((session, token) => { if (session.userId === req.params.id) sessions.delete(token); });
    res.json({ ok: true });
});

// POST /api/settings/:name/increment  body: { deliveredCount: 1 }
app.post("/api/settings/:name/increment", async (req, res) => {
    const settings = readJSON(SETTINGS_FILE);
    const current = settings[req.params.name] || {};
    Object.keys(req.body).forEach(field => {
        const delta = Number(req.body[field]) || 0;
        current[field] = (Number(current[field]) || 0) + delta;
    });
    settings[req.params.name] = current;
    await writeJSON(SETTINGS_FILE, settings);
    res.json(current);
});

// ------------------------------------------------------------
// Image upload: accepts a base64 data URL, saves it as a real
// file under images/uploads/, dedupes identical images by hash.
// Also registered BEFORE the generic /api/:collection routes —
// otherwise "POST /api/upload" would match "/api/:collection"
// with :collection="upload" (not a real collection) and 404.
// ------------------------------------------------------------
app.post("/api/upload", (req, res) => {
    const { dataUrl } = req.body;
    if (!dataUrl || !dataUrl.startsWith("data:image")) {
        return res.status(400).json({ error: "dataUrl must be a base64 image data URL" });
    }
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.*)$/s);
    if (!match) return res.status(400).json({ error: "Invalid data URL" });
    let [, ext, b64] = match;
    if (ext === "jpeg") ext = "jpg";
    const raw = Buffer.from(b64, "base64");
    const hash = crypto.createHash("md5").update(raw).digest("hex");
    const filename = `${hash}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, raw);
    res.json({ url: `images/uploads/${filename}` });
});

// ------------------------------------------------------------
// Generic collection CRUD: products, orders, coupons, feedbacks, notifications
// ------------------------------------------------------------

// GET /api/:collection            -> list all docs
// GET /api/:collection?field=val  -> simple equality filter (used for notifications?productId=...)
app.get("/api/:collection", (req, res) => {
    const file = collectionFile(req.params.collection);
    if (!file) return res.status(404).json({ error: "Unknown collection" });
    let docs = readJSON(file);
    const filters = req.query;
    Object.keys(filters).forEach(key => {
        docs = docs.filter(d => String(d[key]) === String(filters[key]));
    });
    res.json(docs);
});

// GET /api/:collection/:id -> single doc
app.get("/api/:collection/:id", (req, res) => {
    const file = collectionFile(req.params.collection);
    if (!file) return res.status(404).json({ error: "Unknown collection" });
    const docs = readJSON(file);
    const doc = docs.find(d => d.id === req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
});

// POST /api/:collection -> create
app.post("/api/:collection", async (req, res) => {
    const file = collectionFile(req.params.collection);
    if (!file) return res.status(404).json({ error: "Unknown collection" });
    const docs = readJSON(file);
    const newDoc = { ...req.body, id: generateId() };
    docs.push(newDoc);
    await writeJSON(file, docs);
    res.json(newDoc);
});

// PUT /api/:collection/:id -> merge-update (like Firestore .set(data, {merge:true}) or .update(data))
app.put("/api/:collection/:id", async (req, res) => {
    const file = collectionFile(req.params.collection);
    if (!file) return res.status(404).json({ error: "Unknown collection" });
    const docs = readJSON(file);
    const idx = docs.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    docs[idx] = { ...docs[idx], ...req.body, id: req.params.id };
    await writeJSON(file, docs);
    res.json(docs[idx]);
});

// DELETE /api/:collection/:id
app.delete("/api/:collection/:id", async (req, res) => {
    const file = collectionFile(req.params.collection);
    if (!file) return res.status(404).json({ error: "Unknown collection" });
    let docs = readJSON(file);
    const before = docs.length;
    docs = docs.filter(d => d.id !== req.params.id);
    if (docs.length === before) return res.status(404).json({ error: "Not found" });
    await writeJSON(file, docs);
    res.json({ ok: true });
});

// POST /api/products/:id/increment  body: { salesCount: 1, stock: -1 }
// Atomically bumps numeric fields on one product (replaces Firestore FieldValue.increment)
app.post("/api/products/:id/increment", async (req, res) => {
    const file = collectionFile("products");
    const docs = readJSON(file);
    const idx = docs.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    Object.keys(req.body).forEach(field => {
        const delta = Number(req.body[field]) || 0;
        docs[idx][field] = (Number(docs[idx][field]) || 0) + delta;
    });
    await writeJSON(file, docs);
    res.json(docs[idx]);
});

// ------------------------------------------------------------
// PWA files: manifest + service worker, so "Add to Home Screen" launches
// the site as a standalone app (no browser address bar / tabs UI).
// ------------------------------------------------------------
app.get("/manifest.json", (req, res) => res.sendFile(path.join(__dirname, "manifest.json")));
app.get("/sw.js", (req, res) => res.type("application/javascript").sendFile(path.join(__dirname, "sw.js")));

// ------------------------------------------------------------
// Serve the site itself.
// IMPORTANT: we deliberately do NOT do `app.use(express.static(__dirname))`
// here — that would make the entire project folder downloadable, including
// data/settings.json (owner credentials, even hashed, shouldn't be public)
// and index.js itself. Only /images is exposed (handled above), plus
// site.html for every other GET request.
// ------------------------------------------------------------
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "site.html"));
});

// "0.0.0.0" = accept connections from outside the machine (needed when hosted),
// not just from localhost.
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Kuromi Store server is running and listening on port ${PORT}.`);
    console.log(`  - Testing on your own computer: open http://localhost:${PORT}`);
    console.log(`  - When hosted: open the public address your host gave you (its own domain or subdomain).`);
    console.log(`    "localhost" only ever means "this same computer", so it will not work from anywhere else.`);
});
