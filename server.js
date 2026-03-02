const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

let currentMachineClass = 'class2'; 

// ลิงก์ MongoDB ของคุณ
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

function extractClass(raw) {
    if (!raw) return null;
    let str = String(raw).toLowerCase().replace(/\s+/g, '');
    if (str.includes('1')) return 'class1';
    if (str.includes('2')) return 'class2';
    if (str.includes('3')) return 'class3';
    if (str.includes('4')) return 'class4';
    return null;
}

// 📌 ระบบ WebSocket ใหม่ (รับข้อมูลจากบอร์ด + ส่งข้อมูลให้หน้าเว็บ)
wss.on('connection', async (ws) => {
  console.log('✅ มีอุปกรณ์เชื่อมต่อ WebSocket เข้ามาแล้ว');
  
  try {
    const history = await VibrationData.find().sort({ timestamp: -1 }).limit(100);
    ws.send(JSON.stringify({
      type: 'init',
      latest: latestData,
      history: history.reverse(),
      machineClass: currentMachineClass
    }));
  } catch (err) {}

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      // 1. 📡 ถ้าเป็นข้อมูลความสั่นสะเทือนจากบอร์ด ESP32
      if (msg.type === 'sensor') {
        latestData = {
          vrms: parseFloat(msg.vrms) || 0,
          zone: 'A', // เว็บเราคำนวณ Zone เองแล้ว ใส่ A ไว้ก่อนได้
          timestamp: new Date()
        };

        // โยน Class ปัจจุบันกลับไปอัปเดตหน้าจอบอร์ด ESP32
        ws.send(JSON.stringify({ type: 'classUpdate', currentClass: currentMachineClass }));

        // กระจายข้อมูลให้หน้าเว็บ Dashboard ทุกหน้าที่เปิดอยู่
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'update', data: latestData, currentClass: currentMachineClass }));
          }
        });

        // แอบบันทึกลง Database เบื้องหลัง
        new VibrationData(latestData).save().catch(()=>{});
      }
      
      // 2. ⚙️ ถ้าเป็นคำสั่งเปลี่ยน Class จากหน้าเว็บ
      else {
        let rawClass = msg.machineClass || msg.className || msg.class;
        let parsedClass = extractClass(rawClass);
        if (parsedClass) {
          currentMachineClass = parsedClass;
          console.log('⚙️ หน้าเว็บสั่งเปลี่ยนสเปคเป็น:', currentMachineClass);

          // ประกาศบอกทุกคน (รวมถึงบอร์ด ESP32) ว่า Class เปลี่ยนแล้ว
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'classUpdate', currentClass: currentMachineClass }));
            }
          });
        }
      }
    } catch(e) {}
  });

  ws.on('close', () => console.log('❌ อุปกรณ์ยกเลิกการเชื่อมต่อ WebSocket'));
});

function broadcastData(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'update', data: data, currentClass: currentMachineClass }));
    }
  });
}

app.post('/api/class', (req, res) => {
  let rawClass = req.body.machineClass || req.body.className || req.body.class || req.body.value;
  let parsedClass = extractClass(rawClass);
  if (parsedClass) {
    currentMachineClass = parsedClass;
    console.log('⚙️ API รับคำสั่งเปลี่ยนสเปคเป็น:', currentMachineClass);
  }
  res.json({ status: 'success', currentClass: currentMachineClass });
});

app.post('/api/vibration', (req, res) => {
  const { vrms, zone } = req.body;
  
  // 📌 เรดาร์จับสัญญาณ: ถ้า ESP32 ส่งข้อมูลมาถึง ข้อความนี้จะเด้งใน Logs ของ Render ทันที!
  console.log(`📡 ได้รับข้อมูลจาก ESP32 -> ความสั่น: ${vrms} mm/s, Zone: ${zone}`);

  latestData = {
    vrms: parseFloat(vrms) || 0,
    zone: zone || 'A',
    timestamp: new Date()
  };
  
  res.json({ status: 'success', currentClass: currentMachineClass }); 
  
  broadcastData(latestData);
  
  const newData = new VibrationData(latestData);
  newData.save().catch(err => console.error('❌ บันทึกข้อมูลลงฐานข้อมูลล้มเหลว:', err));
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