/**
 * bot.js - Telegram Bot (polling) + Router + UI + Admin
 * Principal Node.js Engineer / Product Designer
 */

const TelegramBot = require('node-telegram-bot-api');
const { db, ADMIN_IDS, BRAND_NAME, BRAND_COLOR, BRAND_ACCENT } = require('./server.js');
const dotenv = require('dotenv');

dotenv.config();

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

let WEBAPP_URL = process.env.WEBAPP_URL || (process.env.APP_URL ? `${process.env.APP_URL}/app` : '');

// Resilience: Handle missing or internal URLs gracefully
if (!WEBAPP_URL || WEBAPP_URL.includes('.internal')) {
  // If we are on Railway, they often provide PUBLIC_DOMAIN, otherwise we wait for user to set APP_URL
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    WEBAPP_URL = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/app`;
  } else if (!WEBAPP_URL) {
    console.error('⚠️ ПРЕДУПРЕЖДЕНИЕ: Переменная APP_URL не настроена. WebApp может не открыться.');
  }
}
const PHONE_PRETTY = process.env.PHONE_PRETTY || '+7 (999) 210-79-77';
const CITY_LABEL = process.env.CITY_LABEL || 'Санкт-Петербург';

// --- HELPERS ---

const lastMessages = {}; // chat_id -> message_id

async function deleteLastMessage(chatId) {
  if (lastMessages[chatId]) {
    try {
      await bot.deleteMessage(chatId, lastMessages[chatId]);
      delete lastMessages[chatId];
    } catch (e) {
      // Silently fail if cannot delete
    }
  }
}

async function renderScreen(chatId, text, keyboard, options = {}) {
  const opts = {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard },
    ...options
  };

  try {
    if (lastMessages[chatId]) {
      // Try to edit the last message to maintain a "single screen" feel
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: lastMessages[chatId],
        ...opts
      }).catch(async (err) => {
        // If edit fails (e.g. content is same or message deleted), delete old and send new
        await deleteLastMessage(chatId);
        const msg = await bot.sendMessage(chatId, text, opts);
        lastMessages[chatId] = msg.message_id;
      });
    } else {
      const msg = await bot.sendMessage(chatId, text, opts);
      lastMessages[chatId] = msg.message_id;
    }
  } catch (e) {
    const msg = await bot.sendMessage(chatId, text, opts);
    lastMessages[chatId] = msg.message_id;
  }
}

function tabBar(isAdmin = false) {
  const tabs = [
    [
      { text: '🏠 Главная', callback_data: 'menu' },
      { text: '📦 Заказы', callback_data: 'my_orders' },
      { text: '➕ Новый', web_app: { url: WEBAPP_URL } }
    ],
    [
      { text: '✅ Чек-лист', callback_data: 'checklist' },
      { text: '👤 Профиль', callback_data: 'profile' }
    ]
  ];
  if (isAdmin) {
    tabs.push([{ text: '📈 Админ-панель', callback_data: 'admin_dashboard' }]);
  }
  return tabs;
}

function getStatusEmoji(status) {
  switch (status) {
    case 'pending': return '🟡';
    case 'confirmed': return '🔵';
    case 'done': return '🟢';
    case 'cancelled': return '🔴';
    default: return '⚪️';
  }
}

// --- SCREENS ---

async function showMenu(chatId, userId) {
  const isAdmin = ADMIN_IDS.includes(userId.toString());
  const text = `<b>${BRAND_NAME}</b>\n${process.env.BRAND_TAGLINE || 'Премиум клининг'}\n\n📍 Работаем в: <b>${CITY_LABEL}</b>\n\nВыберите действие в меню ниже:`;
  
  const keyboard = [
    [{ text: '✨ Заказать уборку', web_app: { url: WEBAPP_URL } }],
    [
      { text: '💰 Прайс-лист', callback_data: 'price' },
      { text: '🧾 Калькулятор', callback_data: 'calc' }
    ],
    [
      { text: '📍 Наши районы', callback_data: 'areas' },
      { text: '💎 Абонементы', callback_data: 'subscriptions' }
    ],
    [{ text: '💬 О нас / Контакты', callback_data: 'about' }],
    ...tabBar(isAdmin)
  ];

  await renderScreen(chatId, text, keyboard);
}

async function showPrice(chatId, userId) {
  const isAdmin = ADMIN_IDS.includes(userId.toString());
  const text = `<b>💰 ПРАЙС-ЛИСТ</b>\n\n<b>🧹 Поддерживающая уборка:</b>\n• До 60 м²: <b>130 ₽/м²</b>\n• 70 - 110 м²: <b>95 ₽/м²</b>\n• От 110 м²: <b>85 ₽/м²</b>\n\n<b>🧼 Генеральная / 🏗 После ремонта:</b>\n• До 60 м²: <b>320 ₽/м²</b>\n• 60 - 110 м²: <b>290 ₽/м²</b>\n• От 110 м²: <b>230 ₽/м²</b>\n\n<i>* Минимальный заказ — 2500 ₽. Итоговая стоимость может быть скорректирована менеджером.</i>`;
  
  const keyboard = [
    [{ text: '✨ Заказать уборку', web_app: { url: WEBAPP_URL } }],
    [{ text: '🔙 Назад в меню', callback_data: 'menu' }],
    ...tabBar(isAdmin)
  ];
  await renderScreen(chatId, text, keyboard);
}

async function showProfile(chatId, userId) {
  const user = db.users[userId] || { name: 'Не указано', phone: 'Не указано', addresses: [] };
  const isAdmin = ADMIN_IDS.includes(userId.toString());
  
  let text = `<b>👤 Профиль</b>\n\n`;
  text += `👤 Имя: ${user.name || '—'}\n`;
  text += `📞 Тел: ${user.phone || '—'}\n\n`;
  
  if (user.addresses.length > 0) {
    text += `📍 <b>Последние адреса:</b>\n`;
    user.addresses.forEach((a, i) => text += `${i+1}. ${a}\n`);
  } else {
    text += `📍 Адреса пока не сохранены.\n`;
  }

  const keyboard = [
    [{ text: '📦 Мои заказы', callback_data: 'my_orders' }],
    [{ text: '✍️ Написать менеджеру', url: `https://t.me/${process.env.TG_USERNAME}` }],
    [{ text: '📞 Позвонить', callback_data: 'call_request' }],
    ...tabBar(isAdmin)
  ];

  await renderScreen(chatId, text, keyboard);
}

async function showMyOrders(chatId, userId) {
  const orders = db.orders.filter(o => o.user_id === userId).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 10);
  const isAdmin = ADMIN_IDS.includes(userId.toString());
  
  let text = `<b>📦 Ваши заказы</b>\n\nЗдесь отображаются ваши последние 10 заявок. Нажмите на заказ для деталей или отмены.\n\n`;
  
  const keyboard = [];
  if (orders.length === 0) {
    text += `У вас пока нет активных или завершенных заказов.`;
  } else {
    orders.forEach(o => {
      text += `${getStatusEmoji(o.status)} #${o.id} — ${o.date} (${o.estimated_price} ₽)\n`;
      keyboard.push([{ text: `🔍 Детали #${o.id}`, callback_data: `view_${o.id}` }]);
    });
  }

  keyboard.push([{ text: '✨ Новый заказ', web_app: { url: WEBAPP_URL } }]);
  keyboard.push([{ text: '🔙 Назад в меню', callback_data: 'menu' }]);
  keyboard.push(...tabBar(isAdmin));

  await renderScreen(chatId, text, keyboard);
}

async function showOrderDetails(chatId, orderId, userId) {
  const order = db.orders.find(o => o.id === orderId);
  if (!order) return bot.answerCallbackQuery(userId, { text: 'Заказ не найден' });
  
  const isAdmin = ADMIN_IDS.includes(userId.toString());
  
  let text = `<b>📄 ДЕТАЛИ ЗАКАЗА #${order.id}</b>\n`;
  text += `Статус: ${getStatusEmoji(order.status)} <b>${order.status.toUpperCase()}</b>\n\n`;
  
  text += `<b>📋 Информация:</b>\n`;
  text += `• Услуга: <b>${order.service}</b>\n`;
  text += `• Объект: ${order.premises} (${order.area} м²)\n`;
  text += `• Дата: <b>${order.date}</b> в <b>${order.time}</b>\n`;
  text += `• Адрес: ${order.address}\n`;
  text += `• Контакт: ${order.name} (${order.phone})\n\n`;
  
  text += `💰 <b>ПРИМЕРНАЯ СТОИМОСТЬ: ${order.estimated_price} ₽</b>\n`;
  text += `<i>(Рассчитано по актуальному прайсу)</i>\n\n`;

  if (order.comment) text += `💬 Комментарий: ${order.comment}\n\n`;

  const keyboard = [];
  if (order.status !== 'done' && order.status !== 'cancelled') {
    keyboard.push([{ text: '❌ Отменить заказ', callback_data: `cancel_${order.id}` }]);
  }
  keyboard.push([{ text: '🔁 Повторить (в приложении)', web_app: { url: `${WEBAPP_URL}?service=${encodeURIComponent(order.service)}&area=${order.area}` } }]);
  keyboard.push([{ text: '🔙 К списку заказов', callback_data: 'my_orders' }]);
  keyboard.push(...tabBar(isAdmin));

  await renderScreen(chatId, text, keyboard);
}

// --- ADMIN SCREENS ---

async function showAdminDashboard(chatId) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  
  const lastWeekOrders = db.orders.filter(o => new Date(o.created_at) > weekAgo);
  const revenue = lastWeekOrders.filter(o => o.status === 'done').reduce((s, o) => s + o.estimated_price, 0);
  const pending = db.orders.filter(o => o.status === 'pending').length;
  
  // Top services
  const services = {};
  lastWeekOrders.forEach(o => services[o.service] = (services[o.service] || 0) + 1);
  const topService = Object.entries(services).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';

  let text = `<b>📈 АДМИН-ДАШБОРД</b>\n\n`;
  text += `⏳ Ожидают: <b>${pending}</b>\n`;
  text += `💰 Выручка (7д): <b>${revenue} ₽</b>\n`;
  text += `🔥 Топ услуга: <b>${topService}</b>\n`;
  text += `📊 Заказов (7д): <b>${lastWeekOrders.length}</b>\n\n`;
  text += `Используйте кнопки ниже для управления:`;

  const keyboard = [
    [
      { text: '⏳ Очередь', callback_data: 'admin_queue' },
      { text: '📅 Сегодня', callback_data: 'admin_today' }
    ],
    [
      { text: '🕒 7 дней', callback_data: 'admin_upcoming' },
      { text: '📋 Все 30', callback_data: 'admin_all' }
    ],
    [
      { text: '🧼 QC Список', callback_data: 'admin_qc_list' },
      { text: '📤 Экспорт CSV', callback_data: 'admin_export' }
    ],
    [{ text: '🏠 Меню', callback_data: 'menu' }]
  ];

  await renderScreen(chatId, text, keyboard);
}

async function showAdminOrderList(chatId, title, filterFn) {
  const orders = db.orders.filter(filterFn).slice(0, 15);
  
  let text = `<b>${title}</b>\n\n`;
  const keyboard = [];
  
  if (orders.length === 0) {
    text += `Список пуст.`;
  } else {
    orders.forEach(o => {
      const over = o.overlimit ? ' ⚠️' : '';
      text += `${getStatusEmoji(o.status)} #${o.id} — ${o.date}${over}\n`;
      keyboard.push([{ text: `⚙️ Управление #${o.id}`, callback_data: `admin_view_${o.id}` }]);
    });
  }

  keyboard.push([{ text: '🔙 Назад', callback_data: 'admin_dashboard' }]);
  await renderScreen(chatId, text, keyboard);
}

async function showAdminOrderDetails(chatId, orderId) {
  const order = db.orders.find(o => o.id === orderId);
  if (!order) return;

  let text = `<b>⚙️ УПРАВЛЕНИЕ #${order.id}</b>\n`;
  text += `Статус: ${getStatusEmoji(order.status)} <b>${order.status.toUpperCase()}</b>\n`;
  if (order.overlimit) text += `⚠️ <b>ВНИМАНИЕ: ОВЕРБУКИНГ</b>\n`;
  text += `\n👤 ${order.name} (${order.phone})\n`;
  text += `📍 ${order.address}\n`;
  text += `📅 ${order.date} в ${order.time}\n`;
  text += `🧼 ${order.service} | ${order.area} м²\n`;
  text += `💰 ${order.estimated_price} ₽\n`;
  if (order.comment) text += `💬 ${order.comment}\n`;

  const keyboard = [
    [
      { text: '✅ Подтвердить', callback_data: `admin_status_${order.id}_confirmed` },
      { text: '❌ Отменить', callback_data: `admin_status_${order.id}_cancelled` }
    ],
    [
      { text: '🕒 Перенести', callback_data: `admin_reschedule_${order.id}` },
      { text: '💬 Написать', callback_data: `admin_msg_${order.id}` }
    ],
    [
      { text: '✅ Выполнено', callback_data: `admin_status_${order.id}_done` },
      { text: '🧼 QC: ' + (order.qc_required ? 'ВКЛ' : 'ВЫКЛ'), callback_data: `admin_qc_toggle_${order.id}` }
    ],
    [{ text: '👤 Контакт', callback_data: `admin_contact_${order.id}` }],
    [{ text: '🔙 Назад', callback_data: 'admin_queue' }]
  ];

  await renderScreen(chatId, text, keyboard);
}

// --- BOT LOGIC ---

// Register bot commands for the Telegram UI menu
bot.setMyCommands([
  { command: 'start', description: 'Запустить бота / Главное меню' },
  { command: 'menu', description: 'Главное меню' },
  { command: 'profile', description: 'Мой профиль' },
  { command: 'orders', description: 'Мои заказы' },
  { command: 'calc', description: 'Калькулятор стоимости' },
  { command: 'price', description: 'Прайс-лист' }
]).catch(err => console.error('Error setting commands:', err));

// Global message handler for cleanup and off-topic filtering
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || '';

  // 1. Always delete user's message to keep the chat clean (App-like feel)
  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (e) {}

  // 2. Handle commands
  if (text.startsWith('/')) {
    const cmd = text.split(' ')[0].toLowerCase();
    if (cmd === '/start' || cmd === '/menu') return showMenu(chatId, userId);
    if (cmd === '/profile') return showProfile(chatId, userId);
    if (cmd === '/orders') return showMyOrders(chatId, userId);
    if (cmd === '/calc') return showPrice(chatId, userId); // Or specific calc screen
    if (cmd === '/price') return showPrice(chatId, userId);
    
    // Other commands like /find, /msg, /move are handled by bot.onText
    return;
  }

  // 3. Handle off-topic (non-command text)
  if (text && !text.startsWith('/')) {
    return showMenu(chatId, userId);
  }
});

bot.onText(/\/find (.+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id.toString())) return;
  const q = match[1].toLowerCase();
  showAdminOrderList(msg.chat.id, `🔍 Результаты поиска: ${q}`, o => 
    o.id.toLowerCase().includes(q) || o.name.toLowerCase().includes(q) || o.phone.includes(q)
  );
});

bot.onText(/\/msg (\w+) (.+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id.toString())) return;
  const orderId = match[1];
  const text = match[2];
  const order = db.orders.find(o => o.id === orderId);
  if (order) {
    // Send to user as a new screen or notification
    await renderScreen(order.chat_id, `<b>💬 Сообщение от менеджера:</b>\n\n${text}`, tabBar(false));
    // Confirm to admin
    await renderScreen(msg.chat.id, `✅ Отправлено пользователю #${orderId}`, tabBar(true));
  }
});

bot.on('callback_query', async (query) => {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const userId = from.id;
  const isAdmin = ADMIN_IDS.includes(userId.toString());

  bot.answerCallbackQuery(query.id);

  if (data === 'menu') showMenu(chatId, userId);
  else if (data === 'price') showPrice(chatId, userId);
  else if (data === 'profile') showProfile(chatId, userId);
  else if (data === 'my_orders') showMyOrders(chatId, userId);
  else if (data === 'about') {
    const text = `<b>О НАС</b>\n\n${BRAND_NAME} — это профессиональный сервис уборки в ${CITY_LABEL}.\n\n✅ Используем эко-средства\n✅ Клинеры с опытом 3+ года\n✅ Контроль качества по чек-листу\n\nСайт: ${process.env.SITE_URL}\nТелефон: ${PHONE_PRETTY}`;
    const keyboard = [
      [{ text: '📞 Заказать звонок', callback_data: 'call_request' }],
      [{ text: '📍 Наши районы', callback_data: 'areas' }],
      ...tabBar(isAdmin)
    ];
    renderScreen(chatId, text, keyboard);
  }
  else if (data === 'areas') {
    const text = `<b>📍 НАШИ РАЙОНЫ</b>\n\nМы работаем по всему <b>Санкт-Петербургу</b> и всей <b>Ленинградской области</b>!\n\n🏙 <b>СПб:</b> Все районы города без исключения.\n🌲 <b>ЛО:</b> Выезд в область обговаривается индивидуально (зависит от удаленности).\n\n<i>Напишите нам адрес, и мы рассчитаем стоимость выезда!</i>`;
    const keyboard = [
      [{ text: '✍️ Написать менеджеру', url: `https://t.me/${process.env.TG_USERNAME}` }],
      [{ text: '🔙 Назад в меню', callback_data: 'menu' }],
      ...tabBar(isAdmin)
    ];
    renderScreen(chatId, text, keyboard);
  }
  else if (data === 'checklist') {
    const text = `<b>✅ ЧЕК-ЛИСТ УБОРКИ</b>\n\nМы работаем по строгому регламенту. Вот что входит в стандарт:\n\n<b>🏠 Комнаты и спальни:</b>\n• Удаление пыли со всех поверхностей\n• Мытье полов и плинтусов\n• Чистка зеркал и стеклянных поверхностей\n• Заправка кровати\n\n<b>🍳 Кухня:</b>\n• Мытье столешницы и фартука\n• Чистка раковины и смесителя\n• Протирка фасадов шкафов\n• Мытье плиты снаружи\n\n<b>🛀 Санузел:</b>\n• Дезинфекция унитаза\n• Мытье ванны/душевой кабины\n• Чистка раковины и смесителей\n\n<i>Генеральная уборка также включает мытье внутри шкафов, духовки и микроволновки.</i>`;
    renderScreen(chatId, text, [[{ text: '✨ Заказать сейчас', web_app: { url: WEBAPP_URL } }], ...tabBar(isAdmin)]);
  }
  else if (data === 'calc') {
    const text = `<b>🧾 КАЛЬКУЛЯТОР СТОИМОСТИ</b>\n\nСначала выберите <b>вид уборки</b>:`;
    const keyboard = [
      [{ text: '🧹 Поддерживающая', callback_data: 'calc_type_sub' }],
      [{ text: '🧼 Генеральная', callback_data: 'calc_type_gen' }],
      [{ text: '🏗 После ремонта', callback_data: 'calc_type_post' }],
      ...tabBar(isAdmin)
    ];
    renderScreen(chatId, text, keyboard);
  }
  else if (data.startsWith('calc_type_')) {
    const type = data.split('_')[2];
    const typeLabel = type === 'sub' ? 'Поддерживающая' : type === 'gen' ? 'Генеральная' : 'После ремонта';
    const text = `<b>🧾 КАЛЬКУЛЯТОР: ${typeLabel.toUpperCase()}</b>\n\nТеперь выберите площадь помещения:`;
    const keyboard = [
      [
        { text: '30-40 м²', callback_data: `calc_res_${type}_40` },
        { text: '50-60 м²', callback_data: `calc_res_${type}_60` }
      ],
      [
        { text: '70-90 м²', callback_data: `calc_res_${type}_90` },
        { text: '100-120 м²', callback_data: `calc_res_${type}_120` }
      ],
      [{ text: '🔙 Назад к видам', callback_data: 'calc' }]
    ];
    renderScreen(chatId, text, keyboard);
  }
  else if (data.startsWith('calc_res_')) {
    const [, , type, area] = data.split('_');
    const a = parseInt(area) || 0;
    let price = 0;
    
    if (type === 'sub') {
      if (a <= 60) price = a * 130;
      else if (a <= 110) price = a * 95;
      else price = a * 85;
    } else {
      if (a <= 60) price = a * 320;
      else if (a <= 110) price = a * 290;
      else price = a * 230;
    }
    
    const typeLabel = type === 'sub' ? 'Поддерживающая' : type === 'gen' ? 'Генеральная' : 'После ремонта';
    
    const text = `<b>🧾 ПРЕДВАРИТЕЛЬНЫЙ РАСЧЕТ</b>\n\nВид: <b>${typeLabel}</b>\nПлощадь: ~<b>${area} м²</b>\nПримерная стоимость: <b>${price} ₽</b>\n\n<i>*Цена может измениться при наличии сильных загрязнений или доп. услуг.</i>`;
    const keyboard = [
      [{ text: '✨ Оформить в приложении', web_app: { url: `${WEBAPP_URL}?service=${encodeURIComponent(typeLabel)}&area=${area}` } }],
      [{ text: '🔄 Посчитать заново', callback_data: 'calc' }],
      ...tabBar(isAdmin)
    ];
    renderScreen(chatId, text, keyboard);
  }
  else if (data === 'subscriptions') {
    const text = `<b>💎 АБОНЕМЕНТЫ</b>\n\nРегулярная чистота — это выгодно!\n\n🔹 <b>3 месяца</b> — скидка 10%\n🔹 <b>6 месяцев</b> — скидка 15%\n🔹 <b>12 месяцев</b> — скидка 20%\n\n<i>Оформите абонемент при создании новой заявки в WebApp.</i>`;
    const keyboard = [
      [{ text: '✨ Перейти к заказу', web_app: { url: WEBAPP_URL } }],
      [{ text: '🔙 Назад в меню', callback_data: 'menu' }],
      ...tabBar(isAdmin)
    ];
    renderScreen(chatId, text, keyboard);
  }
  else if (data === 'call_request') {
    bot.sendMessage(chatId, 'Пожалуйста, отправьте ваш контакт, чтобы мы могли вам перезвонить.', {
      reply_markup: { keyboard: [[{ text: '📱 Отправить контакт', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
    });
  }
  else if (data.startsWith('view_')) showOrderDetails(chatId, data.split('_')[1], userId);
  else if (data.startsWith('cancel_')) {
    const orderId = data.split('_')[1];
    const order = db.orders.find(o => o.id === orderId);
    if (order) {
      order.status = 'cancelled';
      await renderScreen(chatId, `🔴 Заказ #${orderId} отменен.`, tabBar(isAdmin));
      // Optionally show details again after a short delay or just stay on confirmation
      setTimeout(() => showOrderDetails(chatId, orderId, userId), 1500);
    }
  }
  
  // Admin Actions
  else if (isAdmin) {
    if (data === 'admin_dashboard') showAdminDashboard(chatId);
    else if (data === 'admin_queue') showAdminOrderList(chatId, '⏳ ОЧЕРЕДЬ (PENDING)', o => o.status === 'pending');
    else if (data === 'admin_today') {
      const today = new Date().toISOString().split('T')[0];
      showAdminOrderList(chatId, '📅 ЗАКАЗЫ НА СЕГОДНЯ', o => o.date === today && o.status !== 'cancelled');
    }
    else if (data === 'admin_upcoming') {
      const today = new Date();
      const week = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
      showAdminOrderList(chatId, '🕒 СЛЕДУЮЩИЕ 7 ДНЕЙ', o => {
        const d = new Date(o.date);
        return d >= today && d <= week && o.status !== 'cancelled';
      });
    }
    else if (data === 'admin_all') showAdminOrderList(chatId, '📋 ПОСЛЕДНИЕ 30 ЗАКАЗОВ', () => true);
    else if (data === 'admin_qc_list') showAdminOrderList(chatId, '🧼 QC СПИСОК', o => o.qc_required);
    else if (data === 'admin_export') {
      const exportUrl = `${process.env.APP_URL}/export.csv?admin=${userId}`;
      await renderScreen(chatId, `📥 <b>ЭКСПОРТ ДАННЫХ</b>\n\nВаша ссылка на скачивание CSV (все заказы):\n\n<code style="word-break: break-all;">${exportUrl}</code>\n\n<i>Ссылка действительна только для администраторов.</i>`, [[{ text: '🔙 Назад', callback_data: 'admin_dashboard' }]]);
    }
    else if (data.startsWith('admin_view_')) showAdminOrderDetails(chatId, data.split('_')[2]);
    else if (data.startsWith('admin_status_')) {
      const parts = data.split('_');
      const orderId = parts[2];
      const newStatus = parts[3];
      const order = db.orders.find(o => o.id === orderId);
      if (order) {
        order.status = newStatus;
        // Notify user via single screen
        await renderScreen(order.chat_id, `${getStatusEmoji(newStatus)} Статус вашего заказа #${orderId} изменен на: <b>${newStatus.toUpperCase()}</b>`, tabBar(false));
        showAdminOrderDetails(chatId, orderId);
      }
    }
    else if (data.startsWith('admin_qc_toggle_')) {
      const orderId = data.split('_')[3];
      const order = db.orders.find(o => o.id === orderId);
      if (order) {
        order.qc_required = !order.qc_required;
        showAdminOrderDetails(chatId, orderId);
      }
    }
    else if (data.startsWith('admin_contact_')) {
      const orderId = data.split('_')[2];
      const order = db.orders.find(o => o.id === orderId);
      if (order) bot.sendContact(chatId, order.phone, order.name);
    }
    else if (data.startsWith('admin_msg_')) {
      const orderId = data.split('_')[2];
      await renderScreen(chatId, `Чтобы отправить сообщение клиенту, используйте команду:\n\n<code>/msg ${orderId} Текст сообщения</code>\n\n<i>Ваше сообщение будет удалено сразу после отправки.</i>`, [[{ text: '🔙 Назад', callback_data: `admin_view_${orderId}` }]]);
    }
    else if (data.startsWith('admin_reschedule_')) {
      const orderId = data.split('_')[2];
      await renderScreen(chatId, `Чтобы перенести заказ, используйте команду:\n\n<code>/move ${orderId} ГГГГ-ММ-ДД ЧЧ:ММ</code>\n\n<i>Пример: /move ${orderId} 2024-05-20 10:00</i>`, [[{ text: '🔙 Назад', callback_data: `admin_view_${orderId}` }]]);
    }
  }
});

bot.on('contact', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  ADMIN_IDS.forEach(async (adminId) => {
    await renderScreen(adminId, `<b>📞 ЗАПРОС ЗВОНКА</b>\n\nОт: ${msg.from.first_name}\nТел: ${msg.contact.phone_number}`, [[{ text: '👤 Контакт', callback_data: 'ignore' }]]);
    bot.sendContact(adminId, msg.contact.phone_number, msg.from.first_name);
  });

  await renderScreen(chatId, '✅ Спасибо! Менеджер свяжется с вами в ближайшее время.', tabBar(false));
});

// --- WATCHER FOR NEW ORDERS ---
let lastOrderCount = db.orders.length;
setInterval(() => {
  if (db.orders.length > lastOrderCount) {
    const newOrders = db.orders.slice(lastOrderCount);
    newOrders.forEach(async (o) => {
      // Send receipt to user via single screen
      const text = `<b>🟡 Заявка #${o.id} принята!</b>\n\nМы свяжемся с вами для подтверждения в ближайшее время.\n\n📅 Дата: ${o.date} в ${o.time}\n📍 Адрес: ${o.address}\n💰 Цена: ${o.estimated_price} ₽`;
      const keyboard = [
        [{ text: '🔍 Открыть заявку', callback_data: `view_${o.id}` }],
        [{ text: '🏠 Главная', callback_data: 'menu' }]
      ];
      await renderScreen(o.chat_id, text, keyboard);

      // Notify Admins
      ADMIN_IDS.forEach(async (adminId) => {
        const adminText = `<b>🆕 НОВЫЙ ЗАКАЗ #${o.id}</b>\n\n👤 ${o.name}\n📞 ${o.phone}\n📍 ${o.address}\n📅 ${o.date} ${o.time}\n🧼 ${o.service} | ${o.area} м²\n💰 ${o.estimated_price} ₽`;
        await renderScreen(adminId, adminText, [[{ text: '⚙️ Управление', callback_data: `admin_view_${o.id}` }]]);
      });
    });
    lastOrderCount = db.orders.length;
  }
}, 5000);

console.log('Bot is running...');
