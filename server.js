const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// 📌 ตัวแปรจำค่า Class
let currentMachineClass = 'class2'; 

// ฝังลิงก์จริงลงไปตรงๆ เลย บังคับให้ Render อ่านชัวร์ๆ
const MONGODB_URI = 'mongodb+srv://chaturawit2019zaza_db_user:L5IXwEk3lbrp1m48@motordb.baybmu5.mongodb.net/MotorVibDB?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ เชื่อมต่อ MongoDB สำเร็จ 100%!'))
  .catch(err => console.error('❌ Error เชื่อมต่อฐานข้อมูล:', err.message));

const vibrationSchema = new mongoose.Schema({
  vrms: Number,
  zone: String,
  timestamp: { type: Date, default: Date.now }
});

const VibrationData = mongoose.model('VibrationData', vibrationSchema);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let latestData = {
  vrms: 0,
  zone: 'A',
  timestamp: new Date().toISOString()
};

// 📌 ตัวกรองคำอัจฉริยะ (กันเซิร์ฟเวอร์อ่านค่าจากเว็บไม่ออก)
function extractClass(raw) {
    if (!raw) return null;
    let str = String(raw).toLowerCase().replace(/\s+/g, '');
    if (str.includes('1')) return 'class1';
    if (str.includes('2')) return 'class2';
    if (str.includes('3')) return 'class3';
    if (str.includes('4')) return 'class4';
    return null;
}

wss.on('connection', async (ws) => {
  console.log('✅ มีผู้เข้าชม Dashboard');
  
  try {
    const history = await VibrationData.find().sort({ timestamp: -1 }).limit(100);
    const dataHistory = history.reverse();
    
    ws.send(JSON.stringify({
      type: 'init',
      latest: latestData,
      history: dataHistory,
      currentClass: currentMachineClass
    }));
  } catch (err) {
    console.error('Error fetching history:', err);
  }

  // 📌 1. รับค่าจากหน้าเว็บ (ดักจับทุกรูปแบบ)
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      // หน้าเว็บเก่าของคุณอาจจะส่งมาเป็น .value, .class หรือ .className
      let rawClass = msg.className || msg.class || msg.value || msg.data;
      
      let parsedClass = extractClass(rawClass);
      if (parsedClass) {
        currentMachineClass = parsedClass;
        console.log('⚙️ เซิร์ฟเวอร์รับทราบ! เปลี่ยนเป็น:', currentMachineClass);
      }
    } catch(e) {}
  });

  ws.on('close', () => console.log('❌ ผู้เข้าชมออกจาก Dashboard'));
});

function broadcastData(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'update', data: data, currentClass: currentMachineClass }));
    }
  });
}

// 📌 2. API เผื่อหน้าเว็บส่งผ่าน Fetch
app.post('/api/class', (req, res) => {
  let rawClass = req.body.className || req.body.class || req.body.value;
  let parsedClass = extractClass(rawClass);
  if (parsedClass) {
    currentMachineClass = parsedClass;
    console.log('⚙️ เซิร์ฟเวอร์รับทราบทาง API! เปลี่ยนเป็น:', currentMachineClass);
  }
  res.json({ status: 'success', currentClass: currentMachineClass });
});

// 📌 3. ส่ง Class ล่าสุดกลับไปให้ ESP32 ทุกครั้งที่ส่งข้อมูลมา
app.post('/api/vibration', (req, res) => {
  const { vrms, zone } = req.body;
  
  latestData = {
    vrms: parseFloat(vrms) || 0,
    zone: zone || 'A',
    timestamp: new Date()
  };
  
  // โยนข้อมูล Class กลับไปให้ ESP32 เอาไปแสดงบนจอ OLED ทันที
  res.json({ status: 'success', currentClass: currentMachineClass }); 
  
  broadcastData(latestData);
  
  const newData = new VibrationData(latestData);
  newData.save().catch(err => console.error('❌ บันทึกข้อมูลล้มเหลว:', err));
});

app.get('/api/vibration', (req, res) => res.json(latestData));

app.get('/api/history', async (req, res) => {
  try {
    const history = await VibrationData.find().sort({ timestamp: -1 }).limit(1000);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

server.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log(`🚀 Server กำลังทำงานที่พอร์ต: ${PORT}`);
  console.log('='.repeat(50));
});