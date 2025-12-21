require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Database file
const DB_FILE = path.join(__dirname, 'data', 'tickets.json');

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// Initialize database
function initDB() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ tickets: [] }, null, 2));
    }
}
initDB();

// Read tickets from database
function getTickets() {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data).tickets;
}

// Save ticket to database
function saveTicket(ticket) {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    data.tickets.unshift(ticket);
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API Key Configuration
const API_KEY = process.env.API_KEY || crypto.randomBytes(32).toString('hex');
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';

// Ultra Msg WhatsApp Configuration
const ULTRAMSG_INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID;
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN;
const WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID;

// API Key Authentication Middleware
function authenticateAPI(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

    if (!apiKey || apiKey !== API_KEY) {
        return res.status(401).json({
            success: false,
            message: 'مفتاح API غير صالح'
        });
    }
    next();
}

// Admin Authentication Middleware
function authenticateAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-key'] || req.query.key;

    if (!adminKey || adminKey !== ADMIN_KEY) {
        return res.status(401).json({
            success: false,
            message: 'غير مصرح'
        });
    }
    next();
}

// Function to send message to WhatsApp Group via Ultra Msg
async function sendToWhatsApp(message) {
    const url = `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                token: ULTRAMSG_TOKEN,
                to: WHATSAPP_GROUP_ID,
                body: message
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error('Ultra Msg Error:', data.error);
            throw new Error(data.error);
        }

        return data;
    } catch (error) {
        console.error('Error sending to WhatsApp:', error);
        throw error;
    }
}

// Generate Ticket ID
function generateTicketId() {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `TKT-${timestamp}-${random}`;
}

// Format ticket message for WhatsApp
function formatTicketMessage(ticket) {
    const now = new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });

    return `🎫 *بلاغ جديد*

📋 *رقم التذكرة:* ${ticket.ticketId}
👤 *الاسم:* ${ticket.name}
📧 *البريد:* ${ticket.email || 'غير محدد'}
📱 *الجوال:* ${ticket.phone || 'غير محدد'}
📂 *نوع البلاغ:* ${ticket.category}
⚡ *الأولوية:* ${ticket.priority}

📝 *العنوان:*
${ticket.subject}

📄 *التفاصيل:*
${ticket.description}

🕐 *التاريخ:* ${now}
━━━━━━━━━━━━━━━━━━━━━`;
}

// API Route - Submit Ticket (Protected with API Key)
app.post('/api/ticket', authenticateAPI, async (req, res) => {
    try {
        const { name, email, phone, category, priority, subject, description } = req.body;

        // Validation
        if (!name || !email || !phone || !category || !subject || !description) {
            return res.status(400).json({
                success: false,
                message: 'الرجاء تعبئة جميع الحقول المطلوبة (الاسم، البريد، الجوال، النوع، العنوان، التفاصيل)'
            });
        }

        // Create ticket object
        const ticket = {
            ticketId: generateTicketId(),
            name,
            email: email || '',
            phone: phone || '',
            category,
            priority: priority || 'متوسط',
            subject,
            description,
            status: 'جديد',
            createdAt: new Date().toISOString()
        };

        // Save to database
        saveTicket(ticket);

        // Check Ultra Msg configuration
        if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN || !WHATSAPP_GROUP_ID) {
            console.warn('Ultra Msg not configured. Ticket saved locally only.');
            return res.json({
                success: true,
                message: 'تم إرسال البلاغ بنجاح',
                ticketId: ticket.ticketId,
                warning: 'لم يتم إعداد واتساب'
            });
        }

        // Format and send to WhatsApp
        const whatsappMessage = formatTicketMessage(ticket);
        await sendToWhatsApp(whatsappMessage);

        res.json({
            success: true,
            message: 'تم إرسال البلاغ بنجاح',
            ticketId: ticket.ticketId
        });

    } catch (error) {
        console.error('Error submitting ticket:', error);
        res.status(500).json({
            success: false,
            message: 'حدث خطأ أثناء إرسال البلاغ'
        });
    }
});

// API Route - Get All Tickets (Admin only)
app.get('/api/tickets', authenticateAdmin, (req, res) => {
    try {
        const tickets = getTickets();
        res.json({
            success: true,
            count: tickets.length,
            tickets
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'حدث خطأ'
        });
    }
});

// API Route - Get Ticket by ID (Admin only)
app.get('/api/tickets/:id', authenticateAdmin, (req, res) => {
    try {
        const tickets = getTickets();
        const ticket = tickets.find(t => t.ticketId === req.params.id);

        if (!ticket) {
            return res.status(404).json({
                success: false,
                message: 'التذكرة غير موجودة'
            });
        }

        res.json({
            success: true,
            ticket
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'حدث خطأ'
        });
    }
});

// API Route - Update Ticket Status (Admin only)
app.patch('/api/tickets/:id', authenticateAdmin, (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const index = data.tickets.findIndex(t => t.ticketId === req.params.id);

        if (index === -1) {
            return res.status(404).json({
                success: false,
                message: 'التذكرة غير موجودة'
            });
        }

        data.tickets[index] = { ...data.tickets[index], ...req.body };
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

        res.json({
            success: true,
            ticket: data.tickets[index]
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'حدث خطأ'
        });
    }
});

// API Route - Get Statistics (Admin only)
app.get('/api/stats', authenticateAdmin, (req, res) => {
    try {
        const tickets = getTickets();

        const stats = {
            total: tickets.length,
            new: tickets.filter(t => t.status === 'جديد').length,
            inProgress: tickets.filter(t => t.status === 'قيد المعالجة').length,
            resolved: tickets.filter(t => t.status === 'تم الحل').length,
            byCategory: {},
            byPriority: {}
        };

        tickets.forEach(t => {
            stats.byCategory[t.category] = (stats.byCategory[t.category] || 0) + 1;
            stats.byPriority[t.priority] = (stats.byPriority[t.priority] || 0) + 1;
        });

        res.json({
            success: true,
            stats
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'حدث خطأ'
        });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        whatsapp: !!(ULTRAMSG_INSTANCE_ID && ULTRAMSG_TOKEN)
    });
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve archive page
app.get('/archive', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'archive.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔑 API Key: ${API_KEY}`);
    console.log(`👤 Admin Key: ${ADMIN_KEY}`);
    console.log(`📱 WhatsApp: ${ULTRAMSG_INSTANCE_ID ? 'Configured' : 'Not configured'}`);
});
