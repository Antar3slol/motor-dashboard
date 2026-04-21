require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const WebSocket  = require('ws');
const http       = require('http');
const path       = require('path');
const mongoose   = require('mongoose');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── MongoDB ────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ กรุณาตั้งค่า MONGODB_URI ใน .env ก่อนรัน server');
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ เชื่อมต่อ MongoDB สำเร็จ!'))
  .catch(err => console.error('❌ MongoDB Error:', err.message));

// Schema สำหรับเก็บข้อมูล
const vibrationSchema = new mongoose.Schema({
  x:         Number,
  y:         Number,
  z:         Number,
  zoneX:     String,
  zoneY:     String,
  zoneZ:     String,
  timestamp: Date
});

vibrationSchema.index({ timestamp: -1 });
const VibrationData = mongoose.model('VibrationData', vibrationSchema);

// ─── Middleware ─────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// บล็อกไฟล์สำคัญก่อน express.static เพื่อป้องกัน credentials หลุด
const BLOCKED_PATHS = ['/server.js', '/.env', '/package.json', '/package-lock.json', '/yarn.lock'];
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (BLOCKED_PATHS.includes(p) || p.startsWith('/node_modules')) {
    return res.status(403).send('Forbidden');
  }
  next();
});

app.use(express.static(__dirname));

// ─── HTTP + WebSocket Server ────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─── State ──────────────────────────────────────────────────────
let currentMachineClass = 'class1';
let latestData = { x: 0, y: 0, z: 0, zoneX: 'A', zoneY: 'A', zoneZ: 'A', timestamp: new Date() };

// ─── DB Write Rate Limiter (บันทึก Peak Data ทุกๆ 1 วินาที) ─────
const DB_SAVE_INTERVAL_MS = 1000;
let   pendingDbData       = null;

setInterval(() => {
  if (!pendingDbData) return;

  new VibrationData(pendingDbData).save()
    .catch(err => console.error('❌ บันทึก DB ไม่สำเร็จ:', err.message));

  pendingDbData = null; // เคลียร์ค่าหลังจากสั่งบันทึก
}, DB_SAVE_INTERVAL_MS);

// ─── ISO 10816 Zone Calculator ──────────────────────────────────
const machineClassLimits = {
  class1: { A: 2.8,  B: 7.1,  C: 11.2 },
  class2: { A: 4.5,  B: 11.2, C: 18.0 },
  class3: { A: 7.1,  B: 18.0, C: 28.0 },
  class4: { A: 11.2, B: 28.0, C: 45.0 }
};

function calculateZone(vrms, mClass) {
  const lim = machineClassLimits[mClass] || machineClassLimits['class2'];
  if (vrms <= lim.A) return 'A';
  if (vrms <= lim.B) return 'B';
  if (vrms <= lim.C) return 'C';
  return 'D';
}

function extractClass(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/\s+/g, '');
  const match = s.match(/class([1-4])$/);
  if (match) return `class${match[1]}`;
  return null;
}

// ─── WebSocket: Heartbeat ────────────────────────────────────────
const PING_INTERVAL_MS = 30_000;
const heartbeat = setInterval(() => {
  wss.clients.forEach(client => {
    if (client.isAlive === false) return client.terminate();
    client.isAlive = false;
    client.ping();
  });
}, PING_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeat));

// ─── WebSocket: Connection Handler ──────────────────────────────
wss.on('connection', (ws) => {
  console.log('✅ อุปกรณ์/ผู้ใช้ เชื่อมต่อ WebSocket');
  ws.isAlive  = true;
  ws.isSensor = false;

  ws.on('pong', () => { ws.isAlive = true; });

  // ส่ง Class ปัจจุบันให้ทันทีที่เชื่อมต่อ
  ws.send(JSON.stringify({
    type: 'classUpdate',
    currentClass: currentMachineClass
  }));

  // ── Message Handler ───────────────────────────────────────────
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return console.warn('⚠️ JSON ไม่ถูกต้อง:', String(raw).slice(0, 80)); }

    // Dashboard ขอข้อมูล History สำหรับกราฟตอนโหลดหน้าแรก
    if (msg.type === 'dashboard_connect') {
      try {
        const docs    = await VibrationData.find().sort({ timestamp: -1 }).limit(100);
        const history = docs.reverse(); 
        ws.send(JSON.stringify({
          type:         'init',
          latest:       latestData,
          history:      history,
          machineClass: currentMachineClass
        }));
      } catch (err) {
        console.error('❌ ดึง history ไม่ได้:', err.message);
      }
      return;
    }

    // ── Sensor Data (รับข้อมูล Real-time 10Hz จาก ESP32) ────────
    if (msg.type === 'sensor') {
      ws.isSensor = true;

      const vx = isFinite(parseFloat(msg.x)) ? parseFloat(msg.x) : 0;
      const vy = isFinite(parseFloat(msg.y)) ? parseFloat(msg.y) : 0;
      const vz = isFinite(parseFloat(msg.z)) ? parseFloat(msg.z) : 0;

      const calcZX = calculateZone(vx, currentMachineClass);
      const calcZY = calculateZone(vy, currentMachineClass);
      const calcZZ = calculateZone(vz, currentMachineClass);
      const now = new Date();

      latestData = { x: vx, y: vy, z: vz, zoneX: calcZX, zoneY: calcZY, zoneZ: calcZZ, timestamp: now };

      // Broadcast อัปเดตไปยัง Dashboard ทุกจอที่กำลังเปิดอยู่
      const payload = JSON.stringify({
        type:         'update',
        data:         latestData,
        currentClass: currentMachineClass
      });

      wss.clients.forEach(client => {
        if (client !== ws && !client.isSensor && client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      });

      // การกรองเพื่อเก็บบันทึกข้อมูลลง DB
      if (!pendingDbData) {
        pendingDbData = {
          x: vx, y: vy, z: vz,
          zoneX: calcZX, zoneY: calcZY, zoneZ: calcZZ,
          timestamp: now
        };
      } else {
        // เปรียบเทียบความรุนแรงรวม (Vector Magnitude)
        const currentMagnitude = Math.sqrt(vx*vx + vy*vy + vz*vz);
        const pendingMagnitude = Math.sqrt(pendingDbData.x**2 + pendingDbData.y**2 + pendingDbData.z**2);

        if (currentMagnitude > pendingMagnitude) {
          pendingDbData = {
            x: vx, y: vy, z: vz,
            zoneX: calcZX, zoneY: calcZY, zoneZ: calcZZ,
            timestamp: now
          };
        }
      }
      return;
    }

    // ── Machine Class Change (จาก Dashboard สั่งเปลี่ยนสเปก) ──────
    const newClass = extractClass(
      msg.machineClass || msg.className || msg.class || msg.value || msg.data
    );
    
    if (newClass && newClass !== currentMachineClass) {
      currentMachineClass = newClass;
      console.log(`[CLASS] เปลี่ยนเป็น ${currentMachineClass}`);
      
      const classPayload = JSON.stringify({ type: 'classUpdate', currentClass: currentMachineClass });
      
      // แจ้งทุกคนว่าเปลี่ยน Class แล้ว
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(classPayload);
      });

      // 🌟 [ส่วนที่แก้ไข] คำนวณ Zone ของข้อมูลล่าสุดใหม่ แล้วส่งกลับไปที่หน้าเว็บทันที
      if (latestData) {
        latestData.zoneX = calculateZone(latestData.x, currentMachineClass);
        latestData.zoneY = calculateZone(latestData.y, currentMachineClass);
        latestData.zoneZ = calculateZone(latestData.z, currentMachineClass);

        const updatePayload = JSON.stringify({
          type: 'update',
          data: latestData,
          currentClass: currentMachineClass
        });

        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && !client.isSensor) {
            client.send(updatePayload);
          }
        });
      }
    }
  });

  ws.on('close', () => console.log('❌ อุปกรณ์/ผู้ใช้ ยกเลิกการเชื่อมต่อ'));
  ws.on('error', err => console.error('❌ WebSocket Error:', err.message));
});

// ─── REST API ────────────────────────────────────────────────────

// GET /api/history — ดึงข้อมูลย้อนหลัง
app.get('/api/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 1000, 5000);
    const docs  = await VibrationData.find().sort({ timestamp: -1 }).limit(limit);
    res.json(docs);
  } catch (err) {
    console.error('❌ API /history Error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/health — ตรวจสอบสถานะ server
app.get('/api/health', (req, res) => {
  res.json({
    status:       'ok',
    uptime:       Math.floor(process.uptime()),
    db:           mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    wsClients:    wss.clients.size,
    currentClass: currentMachineClass
  });
});

// GET / — Dashboard
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// ─── Start ──────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server ทำงานที่พอร์ต: ${PORT}`);
});

// ─── Graceful Shutdown ───────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[${signal}] ปิด server อย่างปลอดภัย...`);
  server.close(() => {
    mongoose.connection.close(false, () => {
      console.log('✅ ปิด MongoDB และ HTTP server แล้ว');
      process.exit(0);
    });
  });
  setTimeout(() => { console.error('⚠️ Force exit'); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
