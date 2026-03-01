const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// 📌 ตัวแปรจำค่า Class ปัจจุบันของเครื่อง
let currentMachineClass = 'class2'; // ค่าเริ่มต้น

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/MotorVibDB?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ เชื่อมต่อ MongoDB สำเร็จ!'))
  .catch(err => console.error('❌ ไม่สามารถเชื่อมต่อ MongoDB:', err));

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

// 📌 ฟังก์ชันช่วยกรองคำให้ออกมาเป็น "class1", "class2" เสมอ (เพื่อกัน ESP32 เอ๋อ)
function formatClassName(rawName) {
    if (!rawName) return 'class2';
    let str = String(rawName).toLowerCase().replace(/\s+/g, '');
    if (str.includes('1')) return 'class1';
    if (str.includes('2')) return 'class2';
    if (str.includes('3')) return 'class3';
    if (str.includes('4')) return 'class4';
    return 'class2';
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
      currentClass: currentMachineClass // ส่ง Class ปัจจุบันให้หน้าเว็บด้วย
    }));
  } catch (err) {
    console.error('Error fetching history:', err);
  }

  // 📌 รับค่าตอนที่คนกดเปลี่ยน Class บนหน้าเว็บ (ผ่าน WebSocket)
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'changeClass' || msg.className) {
        // ใช้ฟังก์ชันแปลงคำให้ตรงกับ ESP32 เสมอ
        currentMachineClass = formatClassName(msg.className);
        console.log('⚙️ อัปเดต Class เป็น:', currentMachineClass);
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

// 📌 API สำหรับรับค่าเปลี่ยน Class (เผื่อหน้าเว็บใช้ Fetch API)
app.post('/api/class', (req, res) => {
  if (req.body && req.body.className) {
    currentMachineClass = formatClassName(req.body.className);
    console.log('⚙️ หน้าเว็บเปลี่ยน Class เป็น (API):', currentMachineClass);
  }
  res.json({ status: 'success', currentClass: currentMachineClass });
});

// 📌 API: รับข้อมูลจาก ESP32 (ADXL345)
app.post('/api/vibration', (req, res) => {
  const { vrms, zone } = req.body;
  
  latestData = {
    vrms: parseFloat(vrms) || 0,
    zone: zone || 'A',
    timestamp: new Date()
  };
  
  // 1. ตอบกลับ ESP32 "ทันที" แบบไม่รอใคร (แก้ดีเลย์หน้าจอ)
  res.json({ status: 'success', currentClass: currentMachineClass }); 
  
  // 2. กระจายข้อมูลให้หน้าเว็บทั้งหมด
  broadcastData(latestData);
  
  // 3. แอบนำข้อมูลไปบันทึกลง MongoDB แบบเบื้องหลัง
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