require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API Key Configuration
const API_KEY = process.env.API_KEY || crypto.randomBytes(32).toString('hex');

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
        if (!name || !category || !subject || !description) {
            return res.status(400).json({
                success: false,
                message: 'الرجاء تعبئة جميع الحقول المطلوبة'
            });
        }

        // Create ticket object
        const ticket = {
            ticketId: generateTicketId(),
            name,
            email,
            phone,
            category,
            priority: priority || 'متوسط',
            subject,
            description,
            createdAt: new Date()
        };

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

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔑 API Key: ${API_KEY}`);
    console.log(`📱 WhatsApp: ${ULTRAMSG_INSTANCE_ID ? 'Configured' : 'Not configured'}`);
});
