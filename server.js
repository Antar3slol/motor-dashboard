const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 📌 เพิ่มตัวแปรเก็บ Class ปัจจุบันของระบบ (ค่าเริ่มต้นเป็น class2)
let globalMachineClass = 'class2';

let latestData = {
  vrms: 0,
  timestamp: new Date().toISOString()
};

let dataHistory = [];
const MAX_HISTORY = 100;

wss.on('connection', (ws) => {
  console.log('✅ มีผู้เข้าชม Dashboard');
  
  // 📌 ส่งข้อมูลและ Class ปัจจุบันไปให้หน้าเว็บตอนโหลดเข้าเว็บครั้งแรก
  ws.send(JSON.stringify({
    type: 'init',
    latest: latestData,
    history: dataHistory,
    machineClass: globalMachineClass
  }));

  // 📌 รับข้อความจากหน้าเว็บ (รับค่าตอนผู้ใช้กดเปลี่ยน Class)
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'changeMachineClass') {
        globalMachineClass = msg.machineClass;
        console.log('🔄 อัปเดต Class ในระบบเป็น:', globalMachineClass);
        
        // (เผื่อเปิดหลายจอ) แจ้งให้หน้าจออื่นเปลี่ยน Class ตามด้วย
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'machineClassChanged',
              machineClass: globalMachineClass,
              latestData: latestData
            }));
          }
        });
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    console.log('❌ ผู้เข้าชมออกจาก Dashboard');
  });
});

// ส่งข้อมูลไปทุก Client
function broadcastData(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'update',
        data: data
      }));
    }
  });
}

// API: รับข้อมูลจาก ESP32
app.post('/api/vibration', (req, res) => {
  const { vrms } = req.body;
  
  // บันทึกข้อมูล (ไม่รับค่า zone จาก ESP32 แล้ว เพราะให้เว็บคำนวณเอง)
  latestData = {
    vrms: parseFloat(vrms) || 0,
    timestamp: new Date().toISOString()
  };
  
  // เพิ่มในประวัติ
  dataHistory.push(latestData);
  if (dataHistory.length > MAX_HISTORY) {
    dataHistory.shift();
  }
  
  // ส่งข้อมูลไปยังทุก Dashboard
  broadcastData(latestData);
  
  // 📌 ตอบกลับ ESP32 พร้อมแนบค่า Class ปัจจุบันกลับไปให้
  res.json({ 
    status: 'success', 
    data: latestData,
    currentClass: globalMachineClass 
  });
});

// API: ดึงข้อมูลล่าสุด
app.get('/api/vibration', (req, res) => {
  res.json(latestData);
});

// API: ดึงประวัติ
app.get('/api/history', (req, res) => {
  res.json(dataHistory);
});

// API: สำรองสำหรับเว็บเปลี่ยน Class ผ่าน HTTP
app.post('/api/machine-class', (req, res) => {
  if (req.body.machineClass) {
    globalMachineClass = req.body.machineClass;
    console.log('🔄 อัปเดต Class ผ่าน API เป็น:', globalMachineClass);
  }
  res.json({ status: 'success', machineClass: globalMachineClass, latestData });
});

// หน้าหลัก
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// เริ่มต้น Server
server.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log('🚀 Server กำลังทำงาน!');
  console.log('='.repeat(50));
  console.log(`📱 เปิด Dashboard: http://localhost:${PORT}`);
  console.log(`🌐 IP ในเครือข่าย: http://${getLocalIP()}:${PORT}`);
  console.log('='.repeat(50));
  console.log('💡 กด Ctrl+C เพื่อหยุด Server');
  console.log('='.repeat(50));
});

// หา IP Address ของเครื่อง
function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  
  for (let name of Object.keys(interfaces)) {
    for (let iface of interfaces[name]) {
      // ข้าม internal และ non-IPv4
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}