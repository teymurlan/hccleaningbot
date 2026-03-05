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

// Get limits for a date
app.get('/api/limits', authMiddleware, (req, res) => {
  const date = req.query.date;
  if (!date) return res.json({ booked: 0, left: DAILY_LIMIT });
  
  const booked = db.orders
    .filter(o => o.date === date && o.status !== 'cancelled')
    .reduce((sum, o) => sum + (parseInt(o.area) || 0), 0);
  
  res.json({ booked, left: Math.max(0, DAILY_LIMIT - booked) });
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
        :root {
            --bg: #f3f4f6;
            --card: #ffffff;
            --text: #111827;
            --text-muted: #6b7280;
            --primary: ${BRAND_COLOR};
            --accent: ${BRAND_ACCENT};
            --radius: 16px;
        }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background: var(--bg); color: var(--text); margin: 0; padding: 0;
            overflow-x: hidden;
        }
        .header {
            background: var(--primary); color: white; padding: 20px;
            border-bottom-left-radius: 24px; border-bottom-right-radius: 24px;
            position: sticky; top: 0; z-index: 100;
            display: flex; align-items: center; justify-content: space-between;
        }
        .header h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.5px; }
        
        .container { padding: 16px; max-width: 500px; margin: 0 auto; padding-bottom: 80px; }
        
        .screen { display: none; animation: fadeIn 0.3s ease; }
        .screen.active { display: block; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        .card { 
            background: var(--card); border-radius: var(--radius); padding: 16px;
            margin-bottom: 16px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);
            border: 1px solid rgba(0,0,0,0.05);
        }
        .btn {
            width: 100%; padding: 14px; border-radius: 12px; border: none;
            font-size: 16px; font-weight: 600; cursor: pointer;
            transition: opacity 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px;
        }
        .btn-primary { background: var(--accent); color: var(--primary); }
        .btn-secondary { background: #e5e7eb; color: var(--text); }
        .btn:active { opacity: 0.8; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .input-group { margin-bottom: 16px; }
        .input-group label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 6px; color: var(--text-muted); }
        .input-group input, .input-group select, .input-group textarea {
            width: 100%; padding: 12px; border-radius: 10px; border: 1px solid #d1d5db;
            font-size: 16px; background: #f9fafb;
        }
        
        .stepper { display: flex; gap: 8px; margin-bottom: 20px; }
        .step { flex: 1; height: 4px; background: #e5e7eb; border-radius: 2px; }
        .step.active { background: var(--accent); }

        .order-item { 
            display: flex; justify-content: space-between; align-items: center;
            padding: 12px 0; border-bottom: 1px solid #f3f4f6;
        }
        .order-item:last-child { border-bottom: none; }
        .status-badge { 
            padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; text-transform: uppercase;
        }
        .status-pending { background: #fef3c7; color: #92400e; }
        .status-confirmed { background: #dcfce7; color: #166534; }
        .status-done { background: #d1fae5; color: #065f46; }
        .status-cancelled { background: #fee2e2; color: #991b1b; }

        .tab-bar {
            position: fixed; bottom: 0; left: 0; right: 0; background: white;
            display: flex; border-top: 1px solid #e5e7eb; padding: 10px 0;
            padding-bottom: calc(10px + var(--tg-safe-area-inset-bottom));
            z-index: 100;
        }
        .tab { flex: 1; text-align: center; font-size: 10px; color: var(--text-muted); cursor: pointer; }
        .tab.active { color: var(--primary); font-weight: 600; }
        .tab i { display: block; font-size: 20px; margin-bottom: 2px; }

        .price-tag { font-size: 24px; font-weight: 800; color: var(--primary); }
        .limit-warning { background: #fff7ed; border: 1px solid #ffedd5; color: #9a3412; padding: 10px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
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
            <div class="card" style="background: var(--primary); color: white;">
                <h2 style="margin-top: 0;">Привет! ✨</h2>
                <p style="opacity: 0.9; font-size: 14px;">Готовы сделать ваш дом идеально чистым?</p>
                <button class="btn btn-primary" onclick="showScreen('new-order')">✨ Заказать уборку</button>
            </div>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div class="card" onclick="showScreen('my-orders')" style="text-align: center;">
                    <span style="font-size: 24px;">📦</span>
                    <div style="font-weight: 600; margin-top: 8px;">Заказы</div>
                </div>
                <div class="card" onclick="showScreen('subscriptions')" style="text-align: center;">
                    <span style="font-size: 24px;">💎</span>
                    <div style="font-weight: 600; margin-top: 8px;">Абонементы</div>
                </div>
            </div>

            <div class="card">
                <h3 style="margin-top: 0; font-size: 16px;">Наши услуги</h3>
                <div style="font-size: 14px; color: var(--text-muted);">
                    • Поддерживающая уборка<br>
                    • Генеральная уборка<br>
                    • После ремонта<br>
                    • Мытье окон
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
                    <div class="card">
                        <h3>Что убираем?</h3>
                        <div class="input-group">
                            <label>Тип услуги</label>
                            <select name="service" id="f-service" onchange="calcPrice()">
                                <option value="Поддерживающая">Поддерживающая</option>
                                <option value="Генеральная">Генеральная</option>
                                <option value="После ремонта">После ремонта</option>
                                <option value="Окна">Мытье окон</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label>Тип помещения</label>
                            <select name="premises">
                                <option value="Квартира">Квартира</option>
                                <option value="Дом">Дом</option>
                                <option value="Офис">Офис</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label>Площадь (м²)</label>
                            <input type="number" name="area" id="f-area" placeholder="45" required oninput="calcPrice()">
                        </div>
                        <div class="input-group">
                            <label>Комнат</label>
                            <input type="number" name="rooms" placeholder="1" required>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 12px; color: var(--text-muted);">Примерная стоимость:</div>
                            <div class="price-tag"><span id="est-price">0</span> ₽</div>
                        </div>
                    </div>
                    <button type="button" class="btn btn-primary" onclick="nextStep(2)">Далее →</button>
                </div>

                <div id="form-step-2" style="display: none;">
                    <div class="card">
                        <h3>Когда и куда?</h3>
                        <div class="input-group">
                            <label>Дата</label>
                            <input type="date" name="date" id="f-date" required onchange="checkLimits()">
                        </div>
                        <div id="limit-info"></div>
                        <div class="input-group">
                            <label>Время</label>
                            <select name="time">
                                <option value="09:00">09:00</option>
                                <option value="10:00">10:00</option>
                                <option value="12:00">12:00</option>
                                <option value="14:00">14:00</option>
                                <option value="16:00">16:00</option>
                            </select>
                        </div>
                        <div class="input-group">
                            <label>Адрес</label>
                            <textarea name="address" placeholder="Улица, дом, кв..." required rows="2"></textarea>
                        </div>
                    </div>
                    <div style="display: flex; gap: 12px;">
                        <button type="button" class="btn btn-secondary" onclick="nextStep(1)">← Назад</button>
                        <button type="button" class="btn btn-primary" onclick="nextStep(3)">Далее →</button>
                    </div>
                </div>

                <div id="form-step-3" style="display: none;">
                    <div class="card">
                        <h3>Контакты</h3>
                        <div class="input-group">
                            <label>Имя</label>
                            <input type="text" name="name" required>
                        </div>
                        <div class="input-group">
                            <label>Телефон</label>
                            <input type="tel" name="phone" placeholder="+7..." required>
                        </div>
                        <div class="input-group">
                            <label>Комментарий (опционально)</label>
                            <textarea name="comment" rows="2"></textarea>
                        </div>
                        <div class="input-group" style="display: flex; align-items: center; gap: 10px;">
                            <input type="checkbox" name="subscription" id="f-sub" style="width: 20px; height: 20px;">
                            <label for="f-sub" style="margin: 0;">Оформить абонемент (-15%)</label>
                        </div>
                    </div>
                    <div style="display: flex; gap: 12px;">
                        <button type="button" class="btn btn-secondary" onclick="nextStep(2)">← Назад</button>
                        <button type="submit" class="btn btn-primary" id="submit-btn">Оформить заказ</button>
                    </div>
                </div>
            </form>
        </div>

        <!-- MY ORDERS SCREEN -->
        <div id="screen-my-orders" class="screen">
            <h3>Мои заказы</h3>
            <div id="orders-list">Загрузка...</div>
        </div>

        <!-- ORDER DETAILS SCREEN -->
        <div id="screen-order-details" class="screen">
            <button class="btn btn-secondary" onclick="showScreen('my-orders')" style="margin-bottom: 16px; width: auto; padding: 8px 16px;">← К списку</button>
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
        <div class="tab" id="tab-orders" onclick="showScreen('my-orders')"><i>📦</i>Заказы</div>
        <div class="tab" id="tab-new" onclick="showScreen('new-order')"><i>➕</i>Новый</div>
        <div class="tab" id="tab-sub" onclick="showScreen('subscriptions')"><i>💎</i>Абонементы</div>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand();
        const initData = tg.initData;
        const user = tg.initDataUnsafe.user;

        if (user) {
            document.getElementById('user-name').innerText = user.first_name;
        }

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
            const tab = document.getElementById('tab-' + (id === 'new-order' ? 'new' : id === 'my-orders' ? 'orders' : id === 'subscriptions' ? 'sub' : 'home'));
            if (tab) tab.classList.add('active');

            if (id === 'my-orders') loadOrders();
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
            const res = await fetch('/api/limits?date=' + date, {
                headers: { 'x-tg-init-data': initData }
            });
            const data = await res.json();
            const info = document.getElementById('limit-info');
            if (data.left < 50) {
                info.innerHTML = '<div class="limit-warning">⚠️ На эту дату осталось мало мест (' + data.left + ' м²). Заявка может быть перенесена.</div>';
            } else {
                info.innerHTML = '';
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

            list.innerHTML = orders.map(o => \`
                <div class="card" onclick="viewOrder('\${o.id}')">
                    <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                        <span style="font-weight:700;">Заказ #\${o.id}</span>
                        <span class="status-badge status-\${o.status}">\${o.status}</span>
                    </div>
                    <div style="font-size:14px; color:var(--text-muted);">
                        \${o.service} • \${o.date} • \${o.estimated_price} ₽
                    </div>
                </div>
            \`).join('');
        }

        async function viewOrder(id) {
            const content = document.getElementById('order-details-content');
            content.innerHTML = 'Загрузка...';
            showScreen('order-details');
            
            const res = await fetch('/api/order/' + id, {
                headers: { 'x-tg-init-data': initData }
            });
            const o = await res.json();
            
            const steps = [
                { label: 'Принято', done: true },
                { label: 'Подтверждено', done: o.status !== 'pending' && o.status !== 'cancelled' },
                { label: 'Выполнено', done: o.status === 'done' },
                { label: 'Отзыв', done: !!o.review }
            ];

            content.innerHTML = \`
                <div class="card">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                        <h2 style="margin:0;">#\${o.id}</h2>
                        <span class="status-badge status-\${o.status}">\${o.status}</span>
                    </div>
                    
                    <div style="display:flex; justify-content:space-between; margin-bottom:20px;">
                        \${steps.map(s => \`
                            <div style="text-align:center; flex:1;">
                                <div style="width:24px; height:24px; border-radius:50%; background:\${s.done ? 'var(--accent)' : '#e5e7eb'}; margin:0 auto 4px; display:flex; align-items:center; justify-content:center; font-size:12px;">\${s.done ? '✓' : ''}</div>
                                <div style="font-size:10px; color:\${s.done ? 'var(--text)' : 'var(--text-muted)'}">\${s.label}</div>
                            </div>
                        \`).join('')}
                    </div>

                    <div style="font-size:14px; line-height:1.6;">
                        <b>Услуга:</b> \${o.service} (\${o.premises})<br>
                        <b>Объект:</b> \${o.area} м², \${o.rooms} комн.<br>
                        <b>Дата:</b> \${o.date} в \${o.time}<br>
                        <b>Адрес:</b> \${o.address}<br>
                        <b>Цена:</b> \${o.estimated_price} ₽
                    </div>
                    
                    \${o.status !== 'done' && o.status !== 'cancelled' ? \`
                        <button class="btn btn-secondary" style="margin-top:20px; color:#ef4444;" onclick="cancelOrder('\${o.id}')">Отменить заказ</button>
                    \` : ''}
                </div>
            \`;
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
