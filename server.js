require('dotenv').config();
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

let currentMachineClass = 'class2';
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ เชื่อมต่อ MongoDB สำเร็จ 100%!'))
  .catch(err => console.error('❌ Error เชื่อมต่อฐานข้อมูล:', err.message));

// 📌 1. ปรับโครงสร้าง Database ให้รองรับรูปแบบข้อความ (String) ที่ต้องการ
const vibrationSchema = new mongoose.Schema({
  x: String,
  y: String,
  z: String,
  timestamp: String, // เก็บเวลาเป็นข้อความแบบไทย
  
  // ⚠️ ซ่อนค่าตัวเลขดิบไว้ เพื่อให้กราฟ Chart.js บนเว็บดึงไปวาดต่อได้โดยไม่พัง
  raw_x: Number,
  raw_y: Number,
  raw_z: Number,
  raw_zoneX: String,
  raw_zoneY: String,
  raw_zoneZ: String,
  raw_timestamp: Date
});

const VibrationData = mongoose.model('VibrationData', vibrationSchema);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let latestData = { x: 0, y: 0, z: 0, zoneX: 'A', zoneY: 'A', zoneZ: 'A', timestamp: new Date() };

// ฟังก์ชันคำนวณ Zone จาก Server
const machineClassLimits = {
  class1: { A: 2.8, B: 7.1, C: 11.2 },
  class2: { A: 4.5, B: 11.2, C: 18.0 },
  class3: { A: 7.1, B: 18.0, C: 28.0 },
  class4: { A: 11.2, B: 28.0, C: 45.0 }
};

function calculateZoneServer(vrms, mClass) {
  const limits = machineClassLimits[mClass] || machineClassLimits['class2'];
  if (vrms <= limits.A) return 'A';
  if (vrms <= limits.B) return 'B';
  if (vrms <= limits.C) return 'C';
  return 'D';
}

function extractClass(raw) {
    if (!raw) return null;
    let str = String(raw).toLowerCase().replace(/\s+/g, '');
    if (str.includes('1')) return 'class1';
    if (str.includes('2')) return 'class2';
    if (str.includes('3')) return 'class3';
    if (str.includes('4')) return 'class4';
    return null;
}

const interval = setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.isAlive === false) return client.terminate();
    client.isAlive = false;
    client.ping();
  });
}, 30000);

wss.on('connection', async (ws) => {
  console.log('✅ มีอุปกรณ์เชื่อมต่อ WebSocket เข้ามาแล้ว');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  try {
    // 📌 ใช้การเรียงตาม ID (_id) แทน timestamp เพราะ timestamp ตอนนี้เป็น String แล้ว
    const history = await VibrationData.find().sort({ _id: -1 }).limit(100);
    
    // ดึงค่า raw กลับมาแปลงให้ Dashboard ใช้วาดกราฟ
    const formatForDashboard = history.map(doc => ({
      x: doc.raw_x !== undefined ? doc.raw_x : parseFloat(doc.x) || 0,
      y: doc.raw_y !== undefined ? doc.raw_y : parseFloat(doc.y) || 0,
      z: doc.raw_z !== undefined ? doc.raw_z : parseFloat(doc.z) || 0,
      zoneX: doc.raw_zoneX || 'A',
      zoneY: doc.raw_zoneY || 'A',
      zoneZ: doc.raw_zoneZ || 'A',
      timestamp: doc.raw_timestamp || new Date()
    }));

    ws.send(JSON.stringify({ type: 'init', latest: latestData, history: formatForDashboard.reverse(), machineClass: currentMachineClass }));
  } catch (err) {
    console.error('❌ ไม่สามารถดึงประวัติช่วง Init ได้:', err.message);
  }

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'sensor') {
        const vx = parseFloat(msg.x) || 0;
        const vy = parseFloat(msg.y) || 0;
        const vz = parseFloat(msg.z) || 0;

        const zX = calculateZoneServer(vx, currentMachineClass);
        const zY = calculateZoneServer(vy, currentMachineClass);
        const zZ = calculateZoneServer(vz, currentMachineClass);

        const now = new Date();
        
        // 📌 2. สร้างเวลาแบบไทย (UTC+7) 
        const thaiDateStr = now.toLocaleString('th-TH', { 
          timeZone: 'Asia/Bangkok',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });

        // 📌 3. เตรียมข้อมูลสำหรับส่งให้ Dashboard (ส่งตัวเลขไป กราฟจะได้วาดได้)
        latestData = {
          x: vx,
          y: vy,
          z: vz,
          zoneX: zX,
          zoneY: zY,
          zoneZ: zZ,
          timestamp: now
        };

        ws.send(JSON.stringify({ type: 'classUpdate', currentClass: currentMachineClass }));

        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'update', data: latestData, currentClass: currentMachineClass }));
          }
        });

        // 📌 4. เตรียมข้อมูลสำหรับบันทึกลง Database (เก็บตาม Format ที่คุณต้องการเป๊ะๆ)
        const dbData = {
          x: `${vx.toFixed(2)} mm/s : zone : "${zX}"`,
          y: `${vy.toFixed(2)} mm/s : zone : "${zY}"`,
          z: `${vz.toFixed(2)} mm/s : zone : "${zZ}"`,
          timestamp: thaiDateStr, // จะได้ "4 มี.ค. 2569 15:06:15"
          
          // ซ่อนค่าตัวเลขดิบไว้เป็น Backup
          raw_x: vx,
          raw_y: vy,
          raw_z: vz,
          raw_zoneX: zX,
          raw_zoneY: zY,
          raw_zoneZ: zZ,
          raw_timestamp: now
        };

        new VibrationData(dbData).save().catch((err) => {
           console.error('❌ ไม่สามารถบันทึกข้อมูลลง DB ได้:', err.message);
        });
      }
      else {
        let parsedClass = extractClass(msg.machineClass || msg.className || msg.class || msg.value || msg.data);
        if (parsedClass) {
          currentMachineClass = parsedClass;
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'classUpdate', currentClass: currentMachineClass }));
            }
          });
        }
      }
    } catch(e) {
      console.error('❌ ได้รับข้อมูลที่ไม่ได้อยู่ในฟอร์แมต JSON:', message.toString());
    }
  });

  ws.on('close', () => console.log('❌ อุปกรณ์ยกเลิกการเชื่อมต่อ WebSocket'));
});

wss.on('close', () => { clearInterval(interval); });

app.get('/api/history', async (req, res) => {
  try {
    const history = await VibrationData.find().sort({ _id: -1 }).limit(1000);
    
    // คืนค่า raw กลับไปให้ตอนกดโหลด Excel หรือวาดกราฟใช้งานได้ปกติ
    const formatForDashboard = history.map(doc => ({
      x: doc.raw_x !== undefined ? doc.raw_x : parseFloat(doc.x) || 0,
      y: doc.raw_y !== undefined ? doc.raw_y : parseFloat(doc.y) || 0,
      z: doc.raw_z !== undefined ? doc.raw_z : parseFloat(doc.z) || 0,
      zoneX: doc.raw_zoneX || 'A',
      zoneY: doc.raw_zoneY || 'A',
      zoneZ: doc.raw_zoneZ || 'A',
      timestamp: doc.raw_timestamp || new Date()
    }));

    res.json(formatForDashboard);
  } catch (err) {
    console.error('❌ API History Error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
server.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server ทำงานที่พอร์ต: ${PORT}`); });