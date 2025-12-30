require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Firebase Configuration
if (process.env.FIREBASE_CONFIG) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('✅ Connected to Firebase');
    } catch (error) {
        console.error('❌ Firebase config error:', error);
    }
}

const db = admin.apps.length ? admin.firestore() : null;

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

// OpenAI Configuration
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
if (openai) {
    console.log('✅ OpenAI configured');
} else {
    console.log('⚠️ OpenAI not configured - OPENAI_API_KEY missing');
}

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

// Get next ticket number
async function getNextTicketNumber() {
    if (!db) return 1;

    const counterRef = db.collection('settings').doc('counter');
    const counter = await counterRef.get();

    if (!counter.exists) {
        await counterRef.set({ ticketNumber: 1 });
        return 1;
    }

    const newNumber = (counter.data().ticketNumber || 0) + 1;
    await counterRef.update({ ticketNumber: newNumber });
    return newNumber;
}

// Analyze ticket with OpenAI
async function analyzeTicketWithAI(ticketData) {
    if (!openai) {
        console.log('⚠️ OpenAI not available, skipping analysis');
        return ticketData;
    }

    console.log('🤖 Starting OpenAI analysis...');

    try {
        const prompt = `اقرأ بلاغ العميل وافهم ماذا يريد، ثم اكتب جملة واحدة واضحة تشرح طلبه.

العنوان: ${ticketData.subject || ''}
التفاصيل: ${ticketData.description || ''}

تعليمات:
- اكتب جملة واحدة فقط تشرح ماذا يحتاج العميل
- إذا النص غير واضح أو متقطع، حاول فهم المقصود
- تجاهل النصوص الافتراضية مثل "تفاصيل المشكلة" أو "نوع الطلب"

الرد بصيغة JSON فقط:
{"summary": "جملة تشرح طلب العميل"}`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 500
        });

        const content = response.choices[0].message.content;
        console.log('🤖 OpenAI response:', content);

        // Extract JSON from response (in case there's extra text)
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.error('❌ No JSON found in OpenAI response');
            return ticketData;
        }

        const result = JSON.parse(jsonMatch[0]);
        console.log('✅ OpenAI analysis complete');

        return {
            ...ticketData,
            summary: result.summary || '',
            priority: ticketData.priority || result.priority || 'متوسط',
            aiProcessed: true
        };
    } catch (error) {
        console.error('❌ OpenAI Error:', error.message);
        console.error('Full error:', error);
        return ticketData;
    }
}

// Format ticket message for WhatsApp
function formatTicketMessage(ticket) {
    let message = `🎫 *بلاغ #${ticket.ticketNumber}*`;

    if (ticket.name) message += `\n👤 ${ticket.name}`;
    if (ticket.phone) message += `\n📱 ${ticket.phone}`;

    // الملخص من OpenAI
    if (ticket.summary) {
        message += `\n\n📋 ${ticket.summary}`;
    }

    return message;
}

// API Route - Submit Ticket (Protected with API Key)
app.post('/api/ticket', authenticateAPI, async (req, res) => {
    try {
        const { name, email, phone, category, priority, subject, description } = req.body;

        // Validation - فقط الاسم والوصف مطلوبين
        if (!name || !description) {
            return res.status(400).json({
                success: false,
                message: 'الرجاء تعبئة الحقول المطلوبة (الاسم والتفاصيل على الأقل)'
            });
        }

        // Get next ticket number
        const ticketNumber = await getNextTicketNumber();

        // Create ticket object
        let ticketData = {
            ticketId: `TKT-${ticketNumber}`,
            ticketNumber,
            name: name || '',
            email: email || '',
            phone: phone || '',
            category: category || '',
            priority: priority || '',
            subject: subject || '',
            description: description || '',
            status: 'جديد',
            createdAt: new Date().toISOString()
        };

        // Analyze with OpenAI
        console.log('📥 Ticket received:', ticketData.ticketId);
        if (openai) {
            ticketData = await analyzeTicketWithAI(ticketData);
        }

        // Save to Firebase
        if (db) {
            await db.collection('tickets').doc(ticketData.ticketId).set(ticketData);
        }

        // Send to WhatsApp if configured (skip if test mode)
        const skipWhatsapp = req.body.skipWhatsapp || req.query.skipWhatsapp;
        if (ULTRAMSG_INSTANCE_ID && ULTRAMSG_TOKEN && WHATSAPP_GROUP_ID && !skipWhatsapp) {
            try {
                const whatsappMessage = formatTicketMessage(ticketData);
                await sendToWhatsApp(whatsappMessage);
            } catch (whatsappError) {
                console.error('WhatsApp send failed:', whatsappError);
            }
        }

        // Return success
        res.json({
            success: true,
            message: 'تم إرسال البلاغ بنجاح',
            ticketId: ticketData.ticketId,
            aiProcessed: ticketData.aiProcessed || false,
            ticket: ticketData
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
app.get('/api/tickets', authenticateAdmin, async (req, res) => {
    try {
        if (!db) {
            return res.json({ success: true, count: 0, tickets: [] });
        }

        const snapshot = await db.collection('tickets').orderBy('createdAt', 'desc').get();
        const tickets = snapshot.docs.map(doc => doc.data());

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
app.get('/api/tickets/:id', authenticateAdmin, async (req, res) => {
    try {
        if (!db) {
            return res.status(404).json({ success: false, message: 'التذكرة غير موجودة' });
        }

        const doc = await db.collection('tickets').doc(req.params.id).get();

        if (!doc.exists) {
            return res.status(404).json({
                success: false,
                message: 'التذكرة غير موجودة'
            });
        }

        res.json({
            success: true,
            ticket: doc.data()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'حدث خطأ'
        });
    }
});

// API Route - Update Ticket Status (Admin only)
app.patch('/api/tickets/:id', authenticateAdmin, async (req, res) => {
    try {
        if (!db) {
            return res.status(404).json({ success: false, message: 'التذكرة غير موجودة' });
        }

        const docRef = db.collection('tickets').doc(req.params.id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({
                success: false,
                message: 'التذكرة غير موجودة'
            });
        }

        await docRef.update(req.body);
        const updated = await docRef.get();

        res.json({
            success: true,
            ticket: updated.data()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'حدث خطأ'
        });
    }
});

// API Route - Get Statistics (Admin only)
app.get('/api/stats', authenticateAdmin, async (req, res) => {
    try {
        if (!db) {
            return res.json({
                success: true,
                stats: { total: 0, new: 0, inProgress: 0, resolved: 0, byCategory: {}, byPriority: {} }
            });
        }

        const snapshot = await db.collection('tickets').get();
        const tickets = snapshot.docs.map(doc => doc.data());

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
        firebase: !!db,
        whatsapp: !!(ULTRAMSG_INSTANCE_ID && ULTRAMSG_TOKEN),
        openai: !!openai
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
    console.log(`🔥 Firebase: ${db ? 'Connected' : 'Not configured'}`);
    console.log(`🤖 OpenAI: ${openai ? 'Configured' : 'Not configured'}`);
});
