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

// 📌 1. เพิ่มแกน X, Y, Z ในตารางฐานข้อมูล
// เพิ่มแกน x, y, z ลงใน Schema ฐานข้อมูล
const vibrationSchema = new mongoose.Schema({
  vrms: Number,
  x: Number,
  y: Number,
  z: Number,
  zone: String,
  timestamp: { type: Date, default: Date.now }
});

// ... และตรงจุดที่รับข้อมูลจากเซนเซอร์
      if (msg.type === 'sensor') {
        latestData = {
          vrms: parseFloat(msg.vrms) || 0,
          x: parseFloat(msg.x) || 0,
          y: parseFloat(msg.y) || 0,
          z: parseFloat(msg.z) || 0,
          zone: msg.zone || 'A',
          timestamp: new Date() 
        };

const VibrationData = mongoose.model('VibrationData', vibrationSchema);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let latestData = { vrms: 0, x: 0, y: 0, z: 0, zone: 'A', timestamp: new Date() };

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
  } catch (err) {}

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'sensor') {
        // 📌 2. รับค่า X, Y, Z มาบันทึก
        latestData = {
          vrms: parseFloat(msg.vrms) || 0,
          x: parseFloat(msg.x) || 0,
          y: parseFloat(msg.y) || 0,
          z: parseFloat(msg.z) || 0,
          zone: msg.zone || 'A',
          timestamp: new Date() 
        };

        ws.send(JSON.stringify({ type: 'classUpdate', currentClass: currentMachineClass }));

        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'update', data: latestData, currentClass: currentMachineClass }));
          }
        });

        new VibrationData(latestData).save().catch(()=>{});
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
    } catch(e) {}
  });
});

wss.on('close', () => { clearInterval(interval); });

app.get('/api/history', async (req, res) => {
  try {
    const history = await VibrationData.find().sort({ timestamp: -1 }).limit(1000);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
server.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server ทำงานที่พอร์ต: ${PORT}`); });