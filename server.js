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

// 📌 1. โครงสร้างฐานข้อมูลแบบใหม่ (บันทึกแค่ 3 แกน พร้อม Zone ของแต่ละแกน)
const vibrationSchema = new mongoose.Schema({
  x: Number,
  y: Number,
  z: Number,
  zoneX: String,
  zoneY: String,
  zoneZ: String,
  timestamp: { type: Date, default: Date.now }
});

const VibrationData = mongoose.model('VibrationData', vibrationSchema);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let latestData = { x: 0, y: 0, z: 0, zoneX: 'A', zoneY: 'A', zoneZ: 'A', timestamp: new Date() };

// 📌 2. ฟังก์ชันคำนวณ Zone แยกตาม Class
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
    const history = await VibrationData.find().sort({ timestamp: -1 }).limit(100);
    ws.send(JSON.stringify({ type: 'init', latest: latestData, history: history.reverse(), machineClass: currentMachineClass }));
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

        // 📌 3. คำนวณ Zone แยกทีละแกน
        const zX = calculateZoneServer(vx, currentMachineClass);
        const zY = calculateZoneServer(vy, currentMachineClass);
        const zZ = calculateZoneServer(vz, currentMachineClass);

        latestData = {
          x: vx,
          y: vy,
          z: vz,
          zoneX: zX,
          zoneY: zY,
          zoneZ: zZ,
          timestamp: new Date()
        };

        ws.send(JSON.stringify({ type: 'classUpdate', currentClass: currentMachineClass }));

        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'update', data: latestData, currentClass: currentMachineClass }));
          }
        });

        // 📌 4. บันทึกข้อมูลที่ตัด Zone ภาพรวมออกแล้ว ลง Database
        new VibrationData(latestData).save().catch((err) => {
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
    const history = await VibrationData.find().sort({ timestamp: -1 }).limit(1000);
    res.json(history);
  } catch (err) {
    console.error('❌ API History Error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
server.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server ทำงานที่พอร์ต: ${PORT}`); });