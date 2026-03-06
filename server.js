/**
 * server.js - Express + WebApp + API + Scheduler
 * Principal Node.js Engineer / Product Designer
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());

// --- CONFIG ---
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim());
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '300');
const BRAND_NAME = process.env.BRAND_NAME || 'HOUSE CLEANING';
const BRAND_COLOR = process.env.BRAND_COLOR || '#111827';
const BRAND_ACCENT = process.env.BRAND_ACCENT || '#EAB308';
const APP_URL = process.env.APP_URL;

// --- STORAGE (In-Memory + Snapshot) ---
let db = {
  orders: [],
  users: {}, // user_id -> { name, phone, addresses: [] }
  gallery: [], // { id, url, caption }
  lastSent: {
    digest: null,
  }
};

const DB_FILE = path.join(__dirname, 'db_snapshot.json');

function saveSnapshot() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Snapshot save failed', e);
  }
}

function loadSnapshot() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      db = JSON.parse(data);
      console.log('Snapshot loaded:', db.orders.length, 'orders');
    } catch (e) {
      console.error('Snapshot load failed', e);
    }
  }
}

loadSnapshot();
setInterval(saveSnapshot, 60000); // Auto-save every minute

// --- AUTH MIDDLEWARE ---
function validateInitData(initData) {
  if (!initData) return null;
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');
  urlParams.sort();

  let dataCheckString = '';
  for (const [key, value] of urlParams.entries()) {
    dataCheckString += `${key}=${value}\n`;
  }
  dataCheckString = dataCheckString.slice(0, -1);

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (hmac === hash) {
    const user = JSON.parse(urlParams.get('user'));
    return user;
  }
  return null;
}

const authMiddleware = (req, res, next) => {
  const initData = req.headers['x-tg-init-data'];
  const user = validateInitData(initData);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.tgUser = user;
  next();
};

// --- API ROUTES ---

// Health check
app.get('/health', (req, res) => res.send('OK'));

// Root route - Redirect to bot or show landing
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>${BRAND_NAME}</title>
        <style>
            body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #111827; color: white; }
            .btn { background: #EAB308; color: #111827; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin-top: 20px; }
        </style>
    </head>
    <body>
        <h1>${BRAND_NAME} Server 2.0 is Running</h1>
        <p>WebApp is available in Telegram Bot.</p>
        <a href="https://t.me/${process.env.TG_USERNAME || ''}" class="btn">Открыть в Telegram</a>
    </body>
    </html>
  `);
});

// Get availability for calendar
app.get('/api/availability', authMiddleware, (req, res) => {
  const busyDates = {};
  db.orders
    .filter(o => o.status !== 'cancelled')
    .forEach(o => {
      const area = parseInt(o.area) || 0;
      busyDates[o.date] = (busyDates[o.date] || 0) + area;
    });
  
  const fullyBooked = Object.keys(busyDates).filter(date => busyDates[date] >= DAILY_LIMIT);
  res.json({ fullyBooked });
});

// Get order count for a date
app.get('/api/orders-count', authMiddleware, (req, res) => {
  const date = req.query.date;
  if (!date) return res.json({ count: 0, area: 0 });
  
  const orders = db.orders.filter(o => o.date === date && o.status !== 'cancelled');
  const area = orders.reduce((sum, o) => sum + (parseInt(o.area) || 0), 0);
  res.json({ count: orders.length, area });
});

// Create order
app.post('/api/order', authMiddleware, (req, res) => {
  const { service, premises, name, phone, address, date, time, area, rooms, comment, subscription, subscription_months } = req.body;
  
  const orderId = Date.now().toString(36).toUpperCase();
  const estimatedPrice = (parseInt(area) || 0) * 80;
  
  // Check limit
  const bookedOnDate = db.orders
    .filter(o => o.date === date && o.status !== 'cancelled')
    .reduce((sum, o) => sum + (parseInt(o.area) || 0), 0);
  const overlimit = (bookedOnDate + (parseInt(area) || 0)) > DAILY_LIMIT;

  const calculatePrice = (service, area) => {
    const a = parseInt(area) || 0;
    if (service === 'Поддерживающая') {
      if (a <= 60) return a * 130;
      if (a <= 110) return a * 95;
      return a * 85;
    } else if (service === 'Генеральная' || service === 'После ремонта') {
      if (a <= 60) return a * 320;
      if (a <= 110) return a * 290;
      return a * 230;
    }
    return a * 100;
  };

  const newOrder = {
    id: orderId,
    user_id: req.tgUser.id,
    chat_id: req.tgUser.id,
    username: req.tgUser.username,
    created_at: new Date().toISOString(),
    status: 'pending',
    service,
    premises,
    name,
    phone,
    address,
    date,
    time,
    area,
    rooms,
    comment,
    subscription: !!subscription,
    subscription_months: subscription_months || 0,
    estimated_price: calculatePrice(service, area),
    overlimit,
    reminder_24h_sent: false,
    reminder_2h_sent: false,
    qc_required: false,
    review: null
  };

  db.orders.push(newOrder);
  
  // Update user profile
  if (!db.users[req.tgUser.id]) db.users[req.tgUser.id] = { addresses: [] };
  db.users[req.tgUser.id].name = name;
  db.users[req.tgUser.id].phone = phone;
  if (!db.users[req.tgUser.id].addresses.includes(address)) {
    db.users[req.tgUser.id].addresses.unshift(address);
    db.users[req.tgUser.id].addresses = db.users[req.tgUser.id].addresses.slice(0, 3);
  }

  // Notify Bot (via global event or simple check in bot.js if shared memory, but here we'll use a trick)
  // In a real app, you'd use a message queue or a webhook. 
  // For this single-process app, bot.js can just watch db.orders.
  
  res.json({ success: true, order: newOrder });
});

// Get user orders
app.get('/api/orders', authMiddleware, (req, res) => {
  const userOrders = db.orders
    .filter(o => o.user_id === req.tgUser.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 30);
  res.json(userOrders);
});

// Get order details
app.get('/api/order/:id', authMiddleware, (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id && o.user_id === req.tgUser.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(order);
});

// Cancel order
app.post('/api/order/:id/cancel', authMiddleware, (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id && o.user_id === req.tgUser.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  if (order.status === 'done' || order.status === 'cancelled') return res.status(400).json({ error: 'Cannot cancel' });
  
  order.status = 'cancelled';
  res.json({ success: true });
});

// Export CSV (Admin only)
app.get('/export.csv', (req, res) => {
  const adminId = req.query.admin;
  if (!ADMIN_IDS.includes(adminId)) return res.status(403).send('Forbidden');

  const headers = ['ID', 'Date', 'Time', 'Status', 'Service', 'Area', 'Price', 'Name', 'Phone', 'Address', 'User'];
  const rows = db.orders.map(o => [
    o.id, o.date, o.time, o.status, o.service, o.area, o.estimated_price, o.name, o.phone, `"${o.address}"`, o.username || o.user_id
  ]);

  const csvContent = [headers, ...rows].map(r => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=orders.csv');
  res.send(csvContent);
});

// --- WEBAPP HTML ---
app.get('/app', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${BRAND_NAME} Mini App</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&family=Playfair+Display:ital,wght@0,900;1,900&display=swap');
        
        :root {
            --bg: #050505;
            --card: #121212;
            --text: #ffffff;
            --text-muted: #888888;
            --accent: #c5a059; /* Muted Gold */
            --radius: 28px;
            --glass: rgba(255, 255, 255, 0.03);
            --border: rgba(255, 255, 255, 0.08);
            --f-display: 'Playfair Display', serif;
        }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; outline: none; }
        body { 
            font-family: 'Inter', -apple-system, sans-serif;
            background: var(--bg); color: var(--text); margin: 0; padding: 0;
            overflow-x: hidden; -webkit-font-smoothing: antialiased;
            background-image: radial-gradient(circle at 50% 0%, rgba(197, 160, 89, 0.05) 0%, transparent 50%);
        }
        .header {
            background: rgba(5, 5, 5, 0.8); backdrop-filter: blur(30px);
            padding: 24px 20px; position: sticky; top: 0; z-index: 100;
            display: flex; align-items: center; justify-content: space-between;
            border-bottom: 1px solid var(--border);
        }
        .header h1 { margin: 0; font-size: 16px; font-weight: 900; letter-spacing: 4px; text-transform: uppercase; color: var(--accent); font-family: var(--f-display); }
        
        .container { padding: 20px; max-width: 500px; margin: 0 auto; padding-bottom: 140px; }
        
        .screen { display: none; animation: slideUp 0.7s cubic-bezier(0.16, 1, 0.3, 1); }
        .screen.active { display: block; }
        @keyframes slideUp { from { opacity: 0; transform: translateY(50px); } to { opacity: 1; transform: translateY(0); } }

        .card { 
            background: var(--card); border-radius: var(--radius); padding: 32px 24px;
            margin-bottom: 24px; border: 1px solid var(--border);
            box-shadow: 0 30px 60px rgba(0,0,0,0.7);
            position: relative; overflow: hidden;
            transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .card:active { transform: scale(0.98); }
        .card::before {
            content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
            background: linear-gradient(90deg, transparent, var(--border), transparent);
        }

        .btn {
            width: 100%; padding: 24px; border-radius: 22px; border: none;
            font-size: 13px; font-weight: 900; cursor: pointer;
            transition: all 0.5s cubic-bezier(0.16, 1, 0.3, 1);
            display: flex; align-items: center; justify-content: center; gap: 12px;
            text-transform: uppercase; letter-spacing: 3px;
            position: relative; overflow: hidden;
        }
        .btn-primary { background: var(--accent); color: #000; box-shadow: 0 15px 30px rgba(197, 160, 89, 0.2); }
        .btn-secondary { background: var(--glass); color: var(--text); border: 1px solid var(--border); }
        .btn:active { transform: scale(0.95); }
        .btn:disabled { opacity: 0.2; cursor: not-allowed; }

        .input-group { margin-bottom: 32px; }
        .input-group label { display: block; font-size: 10px; font-weight: 900; margin-bottom: 14px; color: var(--accent); text-transform: uppercase; letter-spacing: 2px; }
        .input-group input, .input-group select, .input-group textarea {
            width: 100%; padding: 22px; border-radius: 20px; border: 1px solid var(--border);
            font-size: 16px; background: var(--glass); color: white;
            transition: all 0.4s;
            appearance: none;
        }
        .input-group select {
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23c5a059'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 20px center;
            background-size: 16px;
        }
        .input-group option { background: #1a1a1a; color: white; padding: 10px; }
        .input-group input:focus, .input-group select:focus, .input-group textarea:focus { border-color: var(--accent); background: rgba(255, 255, 255, 0.06); box-shadow: 0 0 30px rgba(197, 160, 89, 0.15); }
        
        .stepper { display: flex; gap: 14px; margin-bottom: 40px; padding: 0 10px; }
        .step { flex: 1; height: 2px; background: var(--border); border-radius: 1px; transition: all 0.5s; }
        .step.active { background: var(--accent); box-shadow: 0 0 20px var(--accent); transform: scaleY(2); }

        .status-badge { 
            padding: 10px 16px; border-radius: 12px; font-size: 9px; font-weight: 900; text-transform: uppercase; letter-spacing: 2px;
        }
        .status-pending { background: rgba(234, 179, 8, 0.05); color: #eab308; border: 1px solid rgba(234, 179, 8, 0.1); }
        .status-confirmed { background: rgba(59, 130, 246, 0.05); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.1); }
        .status-done { background: rgba(34, 197, 94, 0.05); color: #22c55e; border: 1px solid rgba(34, 197, 94, 0.1); }
        .status-cancelled { background: rgba(239, 68, 68, 0.05); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.1); }

        .tab-bar {
            position: fixed; bottom: 0; left: 0; right: 0; background: rgba(5, 5, 5, 0.85);
            backdrop-filter: blur(30px); display: flex; border-top: 1px solid var(--border);
            padding: 16px 0; padding-bottom: calc(16px + var(--tg-safe-area-inset-bottom));
            z-index: 100;
        }
        .tab { flex: 1; text-align: center; font-size: 10px; color: var(--text-muted); cursor: pointer; transition: all 0.3s; text-transform: uppercase; letter-spacing: 1px; font-weight: 700; }
        .tab.active { color: var(--accent); }
        .tab i { display: block; font-size: 24px; margin-bottom: 6px; }

        .price-tag { font-size: 36px; font-weight: 900; color: var(--accent); letter-spacing: -1.5px; }
        .limit-warning { background: rgba(239, 68, 68, 0.05); border: 1px solid rgba(239, 68, 68, 0.1); color: #ef4444; padding: 20px; border-radius: 20px; font-size: 13px; margin-bottom: 24px; font-weight: 700; text-align: center; }
        .limit-ok { background: rgba(34, 197, 94, 0.05); border: 1px solid rgba(34, 197, 94, 0.1); color: #22c55e; padding: 20px; border-radius: 20px; font-size: 13px; margin-bottom: 24px; font-weight: 700; text-align: center; }
        
        .hero-card {
            background: linear-gradient(180deg, #121212 0%, #050505 100%);
            color: white; border-radius: 32px; padding: 40px 30px; margin-bottom: 30px;
            border: 1px solid var(--border); position: relative; overflow: hidden;
            box-shadow: 0 30px 60px rgba(0,0,0,0.6); text-align: center;
        }
        .hero-card h2 { font-size: 28px; font-weight: 900; letter-spacing: -1px; margin-bottom: 12px; }
        .hero-card p { font-size: 16px; color: var(--text-muted); margin-bottom: 30px; }
    </style>
</head>
<body>
    <div class="header">
        <h1 id="header-title">${BRAND_NAME}</h1>
        <div id="user-name" style="font-size: 12px; opacity: 0.8;"></div>
    </div>

    <div class="container">
        <!-- HOME SCREEN -->
        <div id="screen-home" class="screen active">
            <div class="hero-card">
                <h2 style="margin-top: 0; font-family: var(--f-display); font-style: italic;">Чистота как искусство ✨</h2>
                <p style="opacity: 0.8; font-size: 15px; line-height: 1.4; margin-bottom: 32px;">Забронируйте профессиональную уборку за 1 минуту.</p>
                <button class="btn btn-primary" onclick="showScreen('new-order')">✨ Заказать уборку</button>
            </div>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 32px;">
                <div class="card" onclick="showScreen('cabinet')" style="text-align: center; padding: 32px 20px; margin-bottom: 0;">
                    <span style="font-size: 32px; display: block; margin-bottom: 12px;">👤</span>
                    <div style="font-weight: 900; font-size: 11px; text-transform: uppercase; letter-spacing: 1px;">Кабинет</div>
                </div>
                <div class="card" onclick="showScreen('subscriptions')" style="text-align: center; padding: 32px 20px; margin-bottom: 0;">
                    <span style="font-size: 32px; display: block; margin-bottom: 12px;">💎</span>
                    <div style="font-weight: 900; font-size: 11px; text-transform: uppercase; letter-spacing: 1px;">Абонементы</div>
                </div>
            </div>

            <div class="card" style="padding: 32px 24px;">
                <h3 style="margin-top: 0; font-size: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 2px; color: var(--accent); margin-bottom: 24px;">Наши услуги</h3>
                <div style="display: flex; flex-direction: column; gap: 20px;">
                    <div style="display: flex; align-items: center; gap: 16px;">
                        <div style="width: 48px; height: 48px; background: rgba(197, 160, 89, 0.1); border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 24px;">🧹</div>
                        <div>
                            <div style="font-weight: 800; font-size: 15px;">Поддерживающая</div>
                            <div style="font-size: 12px; color: var(--text-muted);">Для регулярного уюта</div>
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 16px;">
                        <div style="width: 48px; height: 48px; background: rgba(197, 160, 89, 0.1); border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 24px;">🧼</div>
                        <div>
                            <div style="font-weight: 800; font-size: 15px;">Генеральная</div>
                            <div style="font-size: 12px; color: var(--text-muted);">Идеальная чистота везде</div>
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 16px;">
                        <div style="width: 48px; height: 48px; background: rgba(197, 160, 89, 0.1); border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 24px;">🏗</div>
                        <div>
                            <div style="font-weight: 800; font-size: 15px;">После ремонта</div>
                            <div style="font-size: 12px; color: var(--text-muted);">Удалим строительную пыль</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- NEW ORDER SCREEN -->
        <div id="screen-new-order" class="screen">
            <div class="stepper">
                <div class="step active" id="step-1"></div>
                <div class="step" id="step-2"></div>
                <div class="step" id="step-3"></div>
            </div>

            <form id="order-form">
                <div id="form-step-1">
                    <div class="card" style="padding: 40px 24px;">
                        <div style="text-align: center; margin-bottom: 32px;">
                            <div style="font-size: 10px; font-weight: 900; color: var(--accent); text-transform: uppercase; letter-spacing: 3px; margin-bottom: 8px;">Шаг 1</div>
                            <h2 style="margin:0; font-family: var(--f-display); font-size: 28px; font-style: italic;">Что убираем?</h2>
                        </div>
                        
                        <div class="input-group">
                            <label>Вид уборки</label>
                            <select name="service" id="f-service" onchange="calcPrice()">
                                <option value="Поддерживающая">🧹 Поддерживающая</option>
                                <option value="Генеральная">🧼 Генеральная</option>
                                <option value="После ремонта">🏗 После ремонта</option>
                                <option value="Окна">🪟 Мытье окон</option>
                            </select>
                        </div>
                        
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                            <div class="input-group">
                                <label>Площадь (м²)</label>
                                <input type="number" name="area" id="f-area" placeholder="45" required oninput="calcPrice()">
                            </div>
                            <div class="input-group">
                                <label>Комнат</label>
                                <input type="number" name="rooms" placeholder="1" required>
                            </div>
                        </div>

                        <div style="text-align: center; padding-top: 20px; border-top: 1px solid var(--border);">
                            <div style="font-size: 11px; font-weight: 900; color: var(--text-muted); text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px;">Примерная стоимость</div>
                            <div class="price-tag" style="font-size: 48px;"><span id="est-price">0</span> ₽</div>
                        </div>
                    </div>
                    <button type="button" class="btn btn-primary" onclick="nextStep(2)">Продолжить ✨</button>
                </div>

                <div id="form-step-2" style="display: none;">
                    <div class="card" style="padding: 40px 24px;">
                        <div style="text-align: center; margin-bottom: 32px;">
                            <div style="font-size: 10px; font-weight: 900; color: var(--accent); text-transform: uppercase; letter-spacing: 3px; margin-bottom: 8px;">Шаг 2</div>
                            <h2 style="margin:0; font-family: var(--f-display); font-size: 28px; font-style: italic;">Когда и куда?</h2>
                        </div>

                        <div class="input-group">
                            <label>Дата визита</label>
                            <input type="date" name="date" id="f-date" required onchange="checkLimits()">
                            <div id="limit-info" style="margin-top: 12px;"></div>
                        </div>

                        <div class="input-group">
                            <label>Удобное время</label>
                            <select name="time">
                                <option value="09:00">09:00</option>
                                <option value="10:00">10:00</option>
                                <option value="12:00">12:00</option>
                                <option value="14:00">14:00</option>
                                <option value="16:00">16:00</option>
                            </select>
                        </div>

                        <div class="input-group">
                            <label>Адрес объекта</label>
                            <textarea name="address" placeholder="Улица, дом, кв..." required rows="2"></textarea>
                        </div>
                    </div>
                    <div style="display: flex; gap: 12px;">
                        <button type="button" class="btn btn-secondary" onclick="nextStep(1)" style="flex: 0.4;">←</button>
                        <button type="button" class="btn btn-primary" onclick="nextStep(3)" style="flex: 1;">Далее ✨</button>
                    </div>
                </div>

                <div id="form-step-3" style="display: none;">
                    <div class="card" style="padding: 40px 24px;">
                        <div style="text-align: center; margin-bottom: 32px;">
                            <div style="font-size: 10px; font-weight: 900; color: var(--accent); text-transform: uppercase; letter-spacing: 3px; margin-bottom: 8px;">Шаг 3</div>
                            <h2 style="margin:0; font-family: var(--f-display); font-size: 28px; font-style: italic;">Ваши контакты</h2>
                        </div>

                        <div class="input-group">
                            <label>Ваше имя</label>
                            <input type="text" name="name" placeholder="Иван Иванов" required>
                        </div>
                        <div class="input-group">
                            <label>Номер телефона</label>
                            <input type="tel" name="phone" placeholder="+7 (999) 000-00-00" required>
                        </div>
                        <div class="input-group">
                            <label>Комментарий</label>
                            <textarea name="comment" placeholder="Например: есть домашние животные..." rows="2"></textarea>
                        </div>
                        
                        <div style="background: rgba(197, 160, 89, 0.05); border: 1px dashed var(--accent); padding: 20px; border-radius: 20px; display: flex; align-items: center; gap: 16px;">
                            <input type="checkbox" name="subscription" id="f-sub" style="width: 24px; height: 24px; accent-color: var(--accent);">
                            <label for="f-sub" style="margin: 0; color: var(--text); font-weight: 700; font-size: 13px; text-transform: none; letter-spacing: 0;">💎 Оформить абонемент (-15%)</label>
                        </div>
                    </div>
                    <div style="display: flex; gap: 12px;">
                        <button type="button" class="btn btn-secondary" onclick="nextStep(2)" style="flex: 0.4;">←</button>
                        <button type="submit" class="btn btn-primary" id="submit-btn" style="flex: 1;">Забронировать ✨</button>
                    </div>
                </div>
            </form>
        </div>

        <!-- CABINET SCREEN -->
        <div id="screen-cabinet" class="screen">
            <div class="card" style="padding: 32px 24px; text-align: center; margin-bottom: 32px;">
                <div style="width: 80px; height: 80px; background: var(--glass); border: 1px solid var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 40px; margin: 0 auto 16px;">👤</div>
                <h2 id="cab-name" style="margin: 0; font-family: var(--f-display); font-size: 28px;">—</h2>
                <div id="cab-phone" style="font-size: 14px; color: var(--text-muted); margin-top: 4px;">—</div>
            </div>
            
            <h3 style="font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: 2px; color: var(--accent); margin-bottom: 16px; padding-left: 10px;">История заказов</h3>
            <div id="orders-list">Загрузка...</div>
        </div>

        <!-- ORDER DETAILS SCREEN -->
        <div id="screen-order-details" class="screen">
            <button class="btn btn-secondary" onclick="showScreen('cabinet')" style="margin-bottom: 24px; width: auto; padding: 12px 24px; border-radius: 16px;">← К списку</button>
            <div id="order-details-content"></div>
        </div>

        <!-- SUBSCRIPTIONS SCREEN -->
        <div id="screen-subscriptions" class="screen">
            <h3>Абонементы 💎</h3>
            <div class="card">
                <div style="font-weight: 700; font-size: 18px; margin-bottom: 8px;">Выгода до 20%</div>
                <p style="font-size: 14px; color: var(--text-muted);">Регулярная уборка по фиксированной цене. Выберите периодичность и забудьте о пыли.</p>
                <div style="background: #f9fafb; padding: 12px; border-radius: 12px; margin-bottom: 12px;">
                    <b>3 месяца</b> — скидка 10%<br>
                    <b>6 месяцев</b> — скидка 15%<br>
                    <b>12 месяцев</b> — скидка 20%
                </div>
                <button class="btn btn-primary" onclick="showScreen('new-order')">Оформить в заказе</button>
            </div>
        </div>
    </div>

    <div class="tab-bar">
        <div class="tab active" id="tab-home" onclick="showScreen('home')"><i>🏠</i>Главная</div>
        <div class="tab" id="tab-cabinet" onclick="showScreen('cabinet')"><i>👤</i>Кабинет</div>
        <div class="tab" id="tab-sub" onclick="showScreen('subscriptions')"><i>💎</i>Абонементы</div>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand();
        const initData = tg.initData;
        const user = tg.initDataUnsafe.user;

        // Pre-fill user data
        const savedUser = ${JSON.stringify(db.users)}[user?.id] || {};
        if (user) {
            document.getElementById('user-name').innerText = user.first_name;
            if (savedUser.name) document.querySelector('input[name="name"]').value = savedUser.name;
            if (savedUser.phone) document.querySelector('input[name="phone"]').value = savedUser.phone;
            if (savedUser.addresses && savedUser.addresses.length > 0) {
                document.querySelector('textarea[name="address"]').value = savedUser.addresses[0];
            }
            
            // Fill cabinet
            document.getElementById('cab-name').innerText = savedUser.name || user.first_name;
            document.getElementById('cab-phone').innerText = savedUser.phone || 'Номер не указан';
        }

        // Set min date to today
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('f-date').setAttribute('min', today);

        loadAvailability();

        // Prefill from query
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('service')) document.getElementById('f-service').value = urlParams.get('service');
        if (urlParams.has('area')) {
            document.getElementById('f-area').value = urlParams.get('area');
            calcPrice();
        }

        function showScreen(id) {
            document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
            document.getElementById('screen-' + id).classList.add('active');
            
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            const tab = document.getElementById('tab-' + id);
            if (tab) tab.classList.add('active');
            
            if (id === 'cabinet') loadOrders();
            window.scrollTo(0, 0);
        }

        function nextStep(step) {
            document.getElementById('form-step-1').style.display = step === 1 ? 'block' : 'none';
            document.getElementById('form-step-2').style.display = step === 2 ? 'block' : 'none';
            document.getElementById('form-step-3').style.display = step === 3 ? 'block' : 'none';
            
            document.querySelectorAll('.step').forEach((s, i) => {
                s.classList.toggle('active', i < step);
            });
        }

        function calcPrice() {
            const area = parseInt(document.getElementById('f-area').value) || 0;
            const service = document.getElementById('f-service').value;
            let price = 0;
            
            if (service === 'Поддерживающая') {
                if (area <= 60) price = area * 130;
                else if (area <= 110) price = area * 95;
                else price = area * 85;
            } else if (service === 'Генеральная' || service === 'После ремонта') {
                if (area <= 60) price = area * 320;
                else if (area <= 110) price = area * 290;
                else price = area * 230;
            } else {
                price = area * 500; // Окна
            }
            
            document.getElementById('est-price').innerText = price;
        }

        async function checkLimits() {
            const date = document.getElementById('f-date').value;
            if (!date) return;
            
            const res = await fetch('/api/orders-count?date=' + date, {
                headers: { 'x-tg-init-data': initData }
            });
            const data = await res.json();
            const info = document.getElementById('limit-info');
            const submitBtn = document.getElementById('submit-btn');
            
            // Limit is 300 m2 per day
            const limit = 300;
            const bookedArea = data.area || 0;
            
            if (bookedArea >= limit) {
                info.innerHTML = '<div class="limit-warning">❌ К сожалению, на этот день лимит (300 м²) исчерпан. Пожалуйста, выберите другую дату.</div>';
                submitBtn.disabled = true;
            } else {
                const left = limit - bookedArea;
                info.innerHTML = '<div class="limit-ok">✅ Дата доступна! Свободно еще ' + left + ' м²</div>';
                submitBtn.disabled = false;
            }
        }

        async function loadAvailability() {
            const res = await fetch('/api/availability', {
                headers: { 'x-tg-init-data': initData }
            });
            const data = await res.json();
            const info = document.getElementById('busy-dates-info');
            if (data.fullyBooked && data.fullyBooked.length > 0) {
                info.innerHTML = '📌 Полностью занятые даты: ' + data.fullyBooked.join(', ');
            } else {
                info.innerHTML = '✨ Все ближайшие даты свободны для записи';
            }
        }

        async function loadOrders() {
            const list = document.getElementById('orders-list');
            const res = await fetch('/api/orders', {
                headers: { 'x-tg-init-data': initData }
            });
            const orders = await res.json();
            
            if (orders.length === 0) {
                list.innerHTML = '<div class="card" style="text-align:center; color:var(--text-muted);">У вас пока нет заказов</div>';
                return;
            }

            list.innerHTML = orders.map(o => {
                return '<div class="card" onclick="viewOrder(\'' + o.id + '\')" style="padding: 24px;">' +
                    '<div style="display:flex; justify-content:space-between; align-items: flex-start; margin-bottom:16px;">' +
                        '<div>' +
                            '<div style="font-size: 10px; font-weight: 900; color: var(--accent); text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 4px;">Заказ #' + o.id + '</div>' +
                            '<div style="font-size: 18px; font-weight: 800; font-family: var(--f-display);">' + o.service + '</div>' +
                        '</div>' +
                        '<span class="status-badge status-' + o.status + '">' + o.status + '</span>' +
                    '</div>' +
                    '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 13px; color: var(--text-muted);">' +
                        '<div>📅 ' + o.date + '</div>' +
                        '<div style="text-align: right;">💰 ' + o.estimated_price + ' ₽</div>' +
                    '</div>' +
                '</div>';
            }).join('');
        }

        async function viewOrder(id) {
            const content = document.getElementById('order-details-content');
            content.innerHTML = '<div style="padding: 100px 0; text-align: center; opacity: 0.5;">Загрузка...</div>';
            showScreen('order-details');
            
            const res = await fetch('/api/order/' + id, {
                headers: { 'x-tg-init-data': initData }
            });
            const o = await res.json();
            
            const steps = [
                { label: 'Принято', done: true },
                { label: 'В работе', done: o.status !== 'pending' && o.status !== 'cancelled' },
                { label: 'Готово', done: o.status === 'done' }
            ];

            content.innerHTML = '<div class="card" style="padding: 40px 24px;">' +
                '<div style="text-align: center; margin-bottom: 32px;">' +
                    '<div style="font-size: 11px; font-weight: 900; color: var(--accent); text-transform: uppercase; letter-spacing: 3px; margin-bottom: 8px;">Детали заказа</div>' +
                    '<h2 style="margin:0; font-family: var(--f-display); font-size: 32px; font-style: italic;">#' + o.id + '</h2>' +
                '</div>' +
                
                '<div style="display:flex; justify-content:space-between; margin-bottom:40px; position: relative; padding: 0 10px;">' +
                    '<div style="position: absolute; top: 12px; left: 40px; right: 40px; height: 1px; background: var(--border); z-index: 0;"></div>' +
                    steps.map((s, i) => {
                        return '<div style="text-align:center; flex:1; position: relative; z-index: 1;">' +
                            '<div style="width:26px; height:26px; border-radius:50%; background:' + (s.done ? 'var(--accent)' : '#1a1a1a') + '; border: 1px solid ' + (s.done ? 'var(--accent)' : 'var(--border)') + '; margin:0 auto 8px; display:flex; align-items:center; justify-content:center; font-size:12px; color: ' + (s.done ? '#000' : 'var(--text-muted)') + '; box-shadow: ' + (s.done ? '0 0 20px rgba(197, 160, 89, 0.4)' : 'none') + '; transition: all 0.5s;">' + (s.done ? '✓' : i+1) + '</div>' +
                            '<div style="font-size:9px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color:' + (s.done ? 'var(--text)' : 'var(--text-muted)') + '">' + s.label + '</div>' +
                        '</div>';
                    }).join('') +
                '</div>' +

                '<div style="display: flex; flex-direction: column; gap: 20px; font-size: 15px;">' +
                    '<div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 12px;">' +
                        '<span style="color: var(--text-muted);">Услуга</span>' +
                        '<span style="font-weight: 700;">' + o.service + '</span>' +
                    '</div>' +
                    '<div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 12px;">' +
                        '<span style="color: var(--text-muted);">Объект</span>' +
                        '<span style="font-weight: 700;">' + o.premises + ' (' + o.area + ' м²)</span>' +
                    '</div>' +
                    '<div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 12px;">' +
                        '<span style="color: var(--text-muted);">Дата и время</span>' +
                        '<span style="font-weight: 700;">' + o.date + ' в ' + o.time + '</span>' +
                    '</div>' +
                    '<div style="display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--border); padding-bottom: 12px;">' +
                        '<span style="color: var(--text-muted);">Адрес</span>' +
                        '<span style="font-weight: 700; line-height: 1.4;">' + o.address + '</span>' +
                    '</div>' +
                    '<div style="display: flex; justify-content: space-between; padding-top: 10px;">' +
                        '<span style="color: var(--accent); font-weight: 900; text-transform: uppercase; letter-spacing: 2px; font-size: 12px;">Итого</span>' +
                        '<span style="font-size: 24px; font-weight: 900; color: var(--accent); font-family: var(--f-display);">' + o.estimated_price + ' ₽</span>' +
                    '</div>' +
                '</div>' +
                
                (o.status !== 'done' && o.status !== 'cancelled' ? 
                    '<button class="btn btn-secondary" style="margin-top:40px; color:#ef4444; border-color: rgba(239, 68, 68, 0.2);" onclick="cancelOrder(\'' + o.id + '\')">Отменить заказ</button>'
                : '') +
            '</div>';
        }

        async function cancelOrder(id) {
            if (!confirm('Вы уверены, что хотите отменить заказ?')) return;
            const res = await fetch('/api/order/' + id + '/cancel', {
                method: 'POST',
                headers: { 'x-tg-init-data': initData }
            });
            if (res.ok) viewOrder(id);
        }

        document.getElementById('order-form').onsubmit = async (e) => {
            e.preventDefault();
            const btn = document.getElementById('submit-btn');
            btn.disabled = true;
            btn.innerText = 'Оформляем...';

            const formData = new FormData(e.target);
            const data = Object.fromEntries(formData.entries());
            data.subscription = formData.get('subscription') === 'on';

            try {
                const res = await fetch('/api/order', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'x-tg-init-data': initData 
                    },
                    body: JSON.stringify(data)
                });
                const result = await res.json();
                if (result.success) {
                    tg.showConfirm('Заказ успешно оформлен! Перейти к деталям?', (ok) => {
                        if (ok) viewOrder(result.order.id);
                        else tg.close();
                    });
                }
            } catch (err) {
                alert('Ошибка при создании заказа');
            } finally {
                btn.disabled = false;
                btn.innerText = 'Оформить заказ';
            }
        };
    </script>
</body>
</html>
  `;
  res.send(html);
});

// --- SCHEDULER ---
function runScheduler() {
  const now = new Date();
  const nowStr = now.toISOString();

  db.orders.forEach(order => {
    if (order.status === 'cancelled' || order.status === 'done') return;

    const orderDate = new Date(`${order.date}T${order.time}`);
    const diffMs = orderDate - now;
    const diffHours = diffMs / (1000 * 60 * 60);

    // 24h Reminder
    if (diffHours <= 24 && diffHours > 23 && !order.reminder_24h_sent) {
      order.reminder_24h_sent = true;
      // Bot will pick this up or we can trigger it here if we had bot instance
    }

    // 2h Reminder
    if (diffHours <= 2 && diffHours > 1 && !order.reminder_2h_sent) {
      order.reminder_2h_sent = true;
    }
  });

  // Weekly Digest (Tue/Sat 12:00)
  const day = now.getDay(); // 0 Sun, 2 Tue, 6 Sat
  const hour = now.getHours();
  if ((day === 2 || day === 6) && hour === 12) {
    const todayKey = now.toISOString().split('T')[0];
    if (db.lastSent.digest !== todayKey) {
      db.lastSent.digest = todayKey;
      // Trigger digest
    }
  }
}

setInterval(runScheduler, 60000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// Export db for bot.js
module.exports = { db, ADMIN_IDS, BRAND_NAME, BRAND_COLOR, BRAND_ACCENT };
