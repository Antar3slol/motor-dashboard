const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose'); // 📌 เพิ่ม Mongoose สำหรับคุยกับ MongoDB

const app = express();
const PORT = process.env.PORT || 3000;

// 📌 1. ตั้งค่าลิงก์เชื่อมต่อ MongoDB (จะรับค่าจาก Render หรือใช้ลิงก์ตรงๆ ก็ได้)
// *** อย่าลืมเปลี่ยน <username> และ <password> เป็นของคุณเอง ***
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/MotorVibDB?retryWrites=true&w=majority';

// 📌 2. เริ่มการเชื่อมต่อ
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ เชื่อมต่อ MongoDB สำเร็จ!'))
  .catch(err => console.error('❌ ไม่สามารถเชื่อมต่อ MongoDB:', err));

// 📌 3. สร้างโครงสร้างตาราง (Schema) สำหรับเก็บข้อมูลความสั่น
const vibrationSchema = new mongoose.Schema({
  vrms: Number,
  zone: String,
  timestamp: { type: Date, default: Date.now }
});

// 📌 สร้าง Model 
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

// เมื่อมีคนเปิดหน้าเว็บ Dashboard
wss.on('connection', async (ws) => {
  console.log('✅ มีผู้เข้าชม Dashboard');
  
  try {
    // 📌 ดึงข้อมูลย้อนหลัง 100 รายการล่าสุดจาก MongoDB เพื่อวาดกราฟตั้งต้น
    const history = await VibrationData.find().sort({ timestamp: -1 }).limit(100);
    const dataHistory = history.reverse(); // กลับด้านข้อมูลให้เรียงจากเก่าไปใหม่
    
    ws.send(JSON.stringify({
      type: 'init',
      latest: latestData,
      history: dataHistory
    }));
  } catch (err) {
    console.error('Error fetching history:', err);
  }

  ws.on('close', () => console.log('❌ ผู้เข้าชมออกจาก Dashboard'));
});

// ฟังก์ชันกระจายข้อมูลให้ทุกหน้าจอ
function broadcastData(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'update', data: data }));
    }
  });
}

// 📌 API: รับข้อมูลจาก ESP32 (ADXL345)
app.post('/api/vibration', async (req, res) => {
  const { vrms, zone } = req.body;
  
  latestData = {
    vrms: parseFloat(vrms) || 0,
    zone: zone || 'A',
    timestamp: new Date()
  };
  
  try {
    // 📌 สร้างเรคคอร์ดใหม่และเซฟลง MongoDB
    const newData = new VibrationData(latestData);
    await newData.save();
    console.log(`💾 บันทึกค่า ${latestData.vrms} mm/s ลงฐานข้อมูลแล้ว`);
  } catch (err) {
    console.error('❌ บันทึกข้อมูลล้มเหลว:', err);
  }
  
  broadcastData(latestData);
  res.json({ status: 'success', data: latestData });
});

// API: ดึงข้อมูลล่าสุด
app.get('/api/vibration', (req, res) => res.json(latestData));

// API: ดึงประวัติทั้งหมด (จำกัด 1000 รายการ ป้องกันเว็บค้าง)
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