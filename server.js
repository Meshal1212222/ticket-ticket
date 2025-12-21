require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Telegram Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Function to send message to Telegram
async function sendToTelegram(message) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            })
        });

        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error sending to Telegram:', error);
        throw error;
    }
}

// Generate Ticket ID
function generateTicketId() {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `TKT-${timestamp}-${random}`;
}

// Format ticket message for Telegram
function formatTicketMessage(ticket) {
    const now = new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });

    return `
🎫 <b>بلاغ جديد</b>

📋 <b>رقم التذكرة:</b> <code>${ticket.ticketId}</code>
👤 <b>الاسم:</b> ${ticket.name}
📧 <b>البريد:</b> ${ticket.email || 'غير محدد'}
📱 <b>الجوال:</b> ${ticket.phone || 'غير محدد'}
📂 <b>نوع البلاغ:</b> ${ticket.category}
⚡ <b>الأولوية:</b> ${ticket.priority}

📝 <b>العنوان:</b>
${ticket.subject}

📄 <b>التفاصيل:</b>
${ticket.description}

🕐 <b>التاريخ:</b> ${now}
━━━━━━━━━━━━━━━━━━━━━
    `.trim();
}

// API Route - Submit Ticket
app.post('/api/ticket', async (req, res) => {
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

        // Check Telegram configuration
        if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
            console.warn('Telegram not configured. Ticket saved locally only.');
            return res.json({
                success: true,
                message: 'تم إرسال البلاغ بنجاح',
                ticketId: ticket.ticketId,
                warning: 'لم يتم إعداد تيليجرام'
            });
        }

        // Format and send to Telegram
        const telegramMessage = formatTicketMessage(ticket);
        await sendToTelegram(telegramMessage);

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
    res.json({ status: 'ok', telegram: !!TELEGRAM_BOT_TOKEN });
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📱 Telegram: ${TELEGRAM_BOT_TOKEN ? 'Configured' : 'Not configured'}`);
});
