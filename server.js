require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
const OpenAI = require('openai');

const { google } = require('googleapis');

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
const ULTRAMSG_INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID || 'instance100568';
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN || 'e4e2cwhdsmxmjycg';
const WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID || '120363213448061192@g.us';

// OpenAI Configuration
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
if (openai) {
    console.log('✅ OpenAI configured');
} else {
    console.log('⚠️ OpenAI not configured - OPENAI_API_KEY missing');
}


// ==================== Gmail Configuration ====================
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = 'https://ticket-ticket-production.up.railway.app/auth/google/callback';

let gmailOAuth2Client = null;
let gmailTokens = null;
let processedEmailIds = new Set(); // تتبع الإيميلات المُرسلة

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    gmailOAuth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI
    );
    console.log('✅ Gmail OAuth configured');
} else {
    console.log('⚠️ Gmail not configured - missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
}

// ==================== فحص Gmail التلقائي ====================
async function autoCheckGmail() {
    if (!gmailOAuth2Client || !db) return;

    try {
        // تحميل الـ tokens من Firebase
        const doc = await db.collection('settings').doc('gmail_tokens').get();
        if (!doc.exists) return;

        const tokens = doc.data().tokens;
        gmailOAuth2Client.setCredentials(tokens);
        const gmail = google.gmail({ version: 'v1', auth: gmailOAuth2Client });

        // تحميل الإيميلات المعالجة من Firebase (مرة واحدة عند البداية)
        if (processedEmailIds.size === 0) {
            const sentEmails = await db.collection('gmail_notifications').get();
            sentEmails.forEach(doc => {
                if (doc.data().emailId) {
                    processedEmailIds.add(doc.data().emailId);
                }
            });
            console.log(`📧 Loaded ${processedEmailIds.size} processed email IDs from Firebase`);
        }

        // جلب كل الإيميلات (مقروءة وغير مقروءة) - بدون إيميلات النظام
        const response = await gmail.users.messages.list({
            userId: 'me',
            maxResults: 10,
            q: '-from:noreply'
        });

        const messages = response.data.messages || [];

        for (const msg of messages) {
            // تخطي الإيميلات المُرسل عنها إشعار سابقاً
            if (processedEmailIds.has(msg.id)) continue;

            try {
                const email = await gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                    format: 'full'
                });

                const headers = email.data.payload.headers;
                const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
                const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
                const date = headers.find(h => h.name === 'Date')?.value || '';

                // فلتر: فقط إيميلات العملاء (الدومينات الشخصية)
                const personalDomains = ['gmail.com', 'hotmail.com', 'yahoo.com', 'outlook.com', 'icloud.com', 'live.com', 'msn.com', 'aol.com', 'protonmail.com', 'ymail.com', 'googlemail.com'];
                const emailMatch = from.match(/@([a-zA-Z0-9.-]+)/);
                const senderDomain = emailMatch ? emailMatch[1].toLowerCase() : '';

                if (!personalDomains.includes(senderDomain)) {
                    // تخطي إيميلات الشركات
                    processedEmailIds.add(msg.id);
                    continue;
                }

                // استخراج الإيميل من الـ from
                const senderEmailMatch = from.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
                const senderEmail = senderEmailMatch ? senderEmailMatch[1].toLowerCase() : '';

                // استخراج محتوى الرسالة
                let body = '';
                const payload = email.data.payload;

                if (payload.body?.data) {
                    body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
                } else if (payload.parts) {
                    for (const part of payload.parts) {
                        if (part.mimeType === 'text/plain' && part.body?.data) {
                            body = Buffer.from(part.body.data, 'base64').toString('utf-8');
                            break;
                        }
                    }
                }

                // استخراج أرقام الجوال من المحتوى
                const phoneMatches = body.match(/(?:\+966|966|05|5)[0-9]{8,9}/g) || [];
                const phones = [...new Set(phoneMatches.map(p => p.replace(/^(\+?966|0)/, '5')))];

                // التحقق من العميل المتكرر
                let isRepeatCustomer = false;
                let repeatInfo = [];

                if (db && senderEmail) {
                    // البحث عن إيميلات سابقة من نفس المرسل
                    const prevEmails = await db.collection('gmail_notifications')
                        .where('senderEmail', '==', senderEmail)
                        .get();

                    if (!prevEmails.empty) {
                        isRepeatCustomer = true;
                        repeatInfo.push(`الإيميل تواصل ${prevEmails.size} مرة سابقاً`);
                    }
                }

                // البحث عن أرقام جوال متكررة
                if (db && phones.length > 0) {
                    for (const phone of phones) {
                        const prevPhones = await db.collection('gmail_notifications')
                            .where('phones', 'array-contains', phone)
                            .get();

                        if (!prevPhones.empty) {
                            isRepeatCustomer = true;
                            repeatInfo.push(`الرقم ${phone} تواصل ${prevPhones.size} مرة سابقاً`);
                        }
                    }
                }

                // تقصير المحتوى إذا كان طويل
                body = body.replace(/<[^>]*>/g, '').trim(); // إزالة HTML
                if (body.length > 500) {
                    body = body.substring(0, 500) + '...';
                }

                // إرسال للواتساب
                if (WHATSAPP_GROUP_ID) {
                    let whatsappMsg = `📧 إيميل جديد!\n\n📤 من: ${from}\n📋 الموضوع: ${subject}\n📅 ${date}`;

                    // إضافة تنبيه العميل المتكرر
                    if (isRepeatCustomer) {
                        whatsappMsg += `\n\n⚠️ *عميل متكرر!*\n${repeatInfo.join('\n')}`;
                    }

                    if (body) {
                        whatsappMsg += `\n\n📝 المحتوى:\n${body}`;
                    }

                    const sendResult = await sendWhatsAppMessage(WHATSAPP_GROUP_ID, whatsappMsg);
                    if (!sendResult) {
                        console.error('❌ Failed to send email notification to WhatsApp, will retry later');
                        continue; // تخطي الحفظ عشان يعيد المحاولة
                    }
                    console.log('📧 Email notification sent:', subject.substring(0, 50));
                }

                // إنشاء بلاغ تلقائي من الإيميل
                try {
                    const ticketNumber = await getNextTicketNumber();
                    const ticketData = {
                        ticketId: `TKT-${ticketNumber}`,
                        ticketNumber,
                        name: from.replace(/<.*>/, '').trim() || 'عميل إيميل',
                        email: senderEmail,
                        phone: phones.length > 0 ? phones[0] : '',
                        subject: subject || 'بلاغ من إيميل',
                        description: body || 'لا يوجد محتوى',
                        category: 'إيميل',
                        source: 'gmail',
                        status: 'جديد',
                        priority: isRepeatCustomer ? 'عالي' : 'متوسط',
                        isRepeatCustomer,
                        createdAt: new Date().toISOString()
                    };

                    await db.collection('tickets').doc(ticketData.ticketId).set(ticketData);
                    console.log('🎫 Ticket created from email:', ticketData.ticketId);
                } catch (ticketErr) {
                    console.error('Error creating ticket from email:', ticketErr.message);
                }

                // حفظ في Firebase
                await db.collection('gmail_notifications').add({
                    emailId: msg.id,
                    from,
                    senderEmail,
                    phones,
                    subject,
                    date,
                    isRepeatCustomer,
                    sentToWhatsApp: !!WHATSAPP_GROUP_ID,
                    timestamp: new Date()
                });

                // إضافة للـ Set لمنع التكرار
                processedEmailIds.add(msg.id);

                await new Promise(r => setTimeout(r, 500));
            } catch (e) {
                console.error('Error processing email:', e.message);
            }
        }
    } catch (error) {
        // تجاهل الأخطاء الصامتة
        if (!error.message?.includes('invalid_grant')) {
            console.error('Auto Gmail check error:', error.message);
        }
    }
}

// فحص Gmail كل دقيقتين
setInterval(autoCheckGmail, 2 * 60 * 1000);
console.log('⏰ Gmail auto-check enabled (every 2 minutes)');

// ==================== Webhook لاستقبال طلبات الفعاليات من بيفاتل ====================
app.post('/webhook/bevatel/event', async (req, res) => {
    try {
        const { event, details, customer_name, customer_phone } = req.body;

        console.log('🎫 Event ticket request received:', { event, details, customer_name, customer_phone });

        // إرسال للقروب
        if (WHATSAPP_GROUP_ID) {
            const groupMessage = `🎫 *طلب تذاكر جديد*\n\n` +
                `📌 *الفعالية:* ${event || 'غير محدد'}\n` +
                `👤 *العميل:* ${customer_name || 'غير معروف'}\n` +
                `📱 *الرقم:* ${customer_phone || 'غير متوفر'}\n\n` +
                `━━━━━━━━━━━━━━━\n` +
                `🎟️ *الفئة والعدد والتفاصيل:*\n${details || 'لا توجد تفاصيل'}\n` +
                `━━━━━━━━━━━━━━━`;

            const url = `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`;
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: ULTRAMSG_TOKEN,
                    to: WHATSAPP_GROUP_ID,
                    body: groupMessage
                })
            });

            console.log('✅ Event request sent to WhatsApp group');
        }

        // حفظ في Firebase
        if (db) {
            await db.collection('event_requests').add({
                event,
                details,
                customer_name,
                customer_phone,
                timestamp: new Date(),
                source: 'bevatel_workflow'
            });
        }

        res.json({ success: true, message: 'تم إرسال الطلب للقروب' });
    } catch (error) {
        console.error('❌ Error processing event request:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== نظام Chatbot قولدن تيكت ====================
let chatbotEnabled = true;

// تتبع حالة المحادثات
const conversationStates = new Map();

// تنظيف المحادثات القديمة كل ساعة
setInterval(() => {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    for (const [chatId, state] of conversationStates.entries()) {
        if (state.lastUpdate < oneHourAgo) {
            conversationStates.delete(chatId);
        }
    }
}, 60 * 60 * 1000);

// إرسال رسالة واتساب
async function sendWhatsAppMessage(to, message) {
    if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) return null;

    const url = `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: ULTRAMSG_TOKEN,
                to: to,
                body: message
            })
        });
        const data = await response.json();
        if (data.error) {
            console.error('❌ WhatsApp Error:', data.error);
            return null;
        }
        console.log('✅ Message sent to:', to);
        return data;
    } catch (error) {
        console.error('❌ Error sending message:', error);
        return null;
    }
}

// إرسال رسالة مع أزرار تفاعلية
async function sendWhatsAppButtons(to, body, buttons) {
    if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN) return null;

    const url = `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/button`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: ULTRAMSG_TOKEN,
                to: to,
                body: body,
                buttons: buttons.join(',')
            })
        });
        const data = await response.json();
        if (data.error) {
            // fallback to regular message if buttons not supported
            const fallbackMsg = body + '\n\n' + buttons.map((b, i) => `${i+1}. ${b}`).join('\n');
            return sendWhatsAppMessage(to, fallbackMsg);
        }
        return data;
    } catch (error) {
        const fallbackMsg = body + '\n\n' + buttons.map((b, i) => `${i+1}. ${b}`).join('\n');
        return sendWhatsAppMessage(to, fallbackMsg);
    }
}

// معالج الـ Chatbot الرئيسي
async function handleChatbot(chatId, messageBody, contactName, contactPhone) {
    const userMessage = messageBody.trim().toLowerCase();
    let state = conversationStates.get(chatId) || { step: 'welcome', data: {}, lastUpdate: Date.now() };

    // تحديث الوقت
    state.lastUpdate = Date.now();
    state.data.contactName = contactName;
    state.data.contactPhone = contactPhone;

    let response = null;

    // ========== معالجة الخطوات ==========

    switch (state.step) {
        case 'welcome':
            response = `✨ أهلاً وسهلاً في قولدن تيكت! 🎫

كيف نقدر نساعدك اليوم؟

1️⃣ شراء تذكرة 🛒
2️⃣ بيع تذكرة 💰
3️⃣ التذكرة ما وصلتني 🎟️
4️⃣ مشكلة في الدفع أو التطبيق 📱
5️⃣ استفسار ثاني ❓

(أرسل رقم الخيار)`;
            state.step = 'main_choice';
            break;

        case 'main_choice':
            if (userMessage.includes('شراء') || userMessage === '1') {
                state.data.mainChoice = 'شراء تذكرة';
                response = `🛒 استفسارك قبل ولا بعد شراء التذكرة؟

1️⃣ أبي أشتري تذكرة
2️⃣ اشتريت وعندي مشكلة

(أرسل رقم الخيار)`;
                state.step = 'buy_timing';
            } else if (userMessage.includes('بيع') || userMessage === '2') {
                state.data.mainChoice = 'بيع تذكرة';
                response = `💰 استفسارك قبل ولا بعد بيع التذكرة؟

1️⃣ قبل البيع
2️⃣ بعد البيع

(أرسل رقم الخيار)`;
                state.step = 'sell_timing';
            } else if (userMessage.includes('وصل') || userMessage.includes('تذكر') || userMessage === '3') {
                state.data.mainChoice = 'التذكرة ما وصلت';
                response = `🎟️ لا تشيل هم! عشان نساعدك بأسرع وقت:

📧 أرسل لنا إيميلك المسجل بالمنصة + رقم الطلب إذا عندك`;
                state.step = 'ticket_not_received';
            } else if (userMessage.includes('دفع') || userMessage.includes('تطبيق') || userMessage.includes('معلق') || userMessage === '4') {
                state.data.mainChoice = 'مشكلة في الدفع أو التطبيق';
                response = `📱 وش المشكلة اللي تواجهك بالضبط؟

1️⃣ الدفع معلق أو ما تم
2️⃣ التطبيق ما يشتغل أو فيه خطأ
3️⃣ QR Code أو الباركود ما يظهر
4️⃣ مشكلة ثانية

(أرسل رقم الخيار)`;
                state.step = 'app_payment_issue';
            } else if (userMessage.includes('استفسار') || userMessage === '5') {
                state.data.mainChoice = 'استفسار عام';
                response = `📝 ابشر! اكتب لنا استفسارك وبنساعدك 💪`;
                state.step = 'general_issue';
            } else {
                response = `⚠️ عذراً، لم أفهم اختيارك

الرجاء اختيار رقم من 1 إلى 5:
1️⃣ شراء تذكرة
2️⃣ بيع تذكرة
3️⃣ التذكرة ما وصلتني
4️⃣ مشكلة في الدفع أو التطبيق
5️⃣ استفسار ثاني`;
            }
            break;

        // ========== التذكرة ما وصلت (المشكلة #1) ==========
        case 'ticket_not_received':
            state.data.userProblem = messageBody;
            const ticketEmailMatch = messageBody.match(/[\w.-]+@[\w.-]+\.\w+/);
            if (ticketEmailMatch) state.data.email = ticketEmailMatch[0];
            await createTicket(chatId, state.data);
            response = `✅ وصلنا بلاغك!

⏰ فريق الدعم بيتواصل معك بأسرع وقت إن شاء الله

💡 تقدر تتابع حالة تذكرتك من حسابك بالمنصة 🙏💙`;
            state.step = 'completed';
            break;

        // ========== مشاكل الدفع والتطبيق ==========
        case 'app_payment_issue':
            if (userMessage === '1' || userMessage.includes('دفع') || userMessage.includes('معلق')) {
                state.data.issueType = 'الدفع معلق أو ما تم';
            } else if (userMessage === '2' || userMessage.includes('تطبيق') || userMessage.includes('خطأ')) {
                state.data.issueType = 'التطبيق ما يشتغل';
            } else if (userMessage === '3' || userMessage.includes('qr') || userMessage.includes('باركود')) {
                state.data.issueType = 'QR Code ما يظهر';
            } else if (userMessage === '4' || userMessage.includes('ثاني')) {
                state.data.issueType = 'مشكلة أخرى';
            } else {
                state.data.issueType = messageBody;
            }
            response = `📝 اكتب لنا تفاصيل المشكلة (رقم الطلب + إيميلك المسجل إذا ممكن) 💪`;
            state.step = 'app_payment_describe';
            break;

        case 'app_payment_describe':
            state.data.userProblem = messageBody;
            const appEmailMatch = messageBody.match(/[\w.-]+@[\w.-]+\.\w+/);
            if (appEmailMatch) state.data.email = appEmailMatch[0];
            await createTicket(chatId, state.data);
            response = `✅ وصلنا بلاغك!
فريق الدعم الفني بيتواصل معك بأسرع وقت إن شاء الله 🙏💙`;
            state.step = 'completed';
            break;

        // ========== استفسار عام ==========
        case 'general_issue':
            state.data.userProblem = messageBody;
            const generalEmailMatch = messageBody.match(/[\w.-]+@[\w.-]+\.\w+/);
            if (generalEmailMatch) state.data.email = generalEmailMatch[0];
            await createTicket(chatId, state.data);
            response = `✅ وصلنا طلبك!
بنتواصل معك في أقرب وقت إن شاء الله 🙏💙`;
            state.step = 'completed';
            break;

        // ========== مسار الشراء ==========
        case 'buy_timing':
            if (userMessage.includes('قبل') || userMessage.includes('اشتري') || userMessage.includes('أبي') || userMessage === '1') {
                state.data.timing = 'قبل الشراء';
                response = `🎯 ابشر! وش اسم الفعالية اللي تبي تشتري تذكرة لها؟`;
                state.step = 'buy_event_name';
            } else if (userMessage.includes('بعد') || userMessage.includes('اشتريت') || userMessage.includes('مشكلة') || userMessage === '2') {
                state.data.timing = 'بعد الشراء';
                response = `⚡ طيب، وش نوع المشكلة؟

1️⃣ التذكرة ما وصلتني
2️⃣ التذكرة غلط أو فيها مشكلة
3️⃣ أبي أسترجع المبلغ
4️⃣ مشكلة ثانية

(أرسل رقم الخيار)`;
                state.step = 'buy_after_issue';
            } else {
                response = `⚠️ الرجاء اختيار:
1️⃣ أبي أشتري تذكرة
2️⃣ اشتريت وعندي مشكلة`;
            }
            break;

        case 'buy_event_name':
            state.data.eventName = messageBody;
            state.data.userProblem = messageBody;
            await createTicket(chatId, state.data);
            response = `✅ وصلنا طلبك!
بنتواصل معك في أقرب وقت إن شاء الله 🙏💙`;
            state.step = 'completed';
            break;

        case 'buy_after_issue':
            if (userMessage === '1' || userMessage.includes('وصل')) {
                state.data.issueType = 'التذكرة ما وصلت';
            } else if (userMessage === '2' || userMessage.includes('غلط')) {
                state.data.issueType = 'التذكرة غلط أو فيها مشكلة';
            } else if (userMessage === '3' || userMessage.includes('استرجاع') || userMessage.includes('استرداد')) {
                state.data.issueType = 'استرجاع مبلغ';
            } else if (userMessage === '4') {
                state.data.issueType = 'مشكلة أخرى';
            } else {
                state.data.issueType = messageBody;
            }
            response = `📝 لا تشيل هم! اكتب لنا التفاصيل:
• اسم الفعالية
• رقم الطلب إذا عندك
• إيميلك المسجل بالمنصة 💫`;
            state.step = 'buy_after_describe';
            break;

        case 'buy_after_describe':
            state.data.userProblem = messageBody;
            const emailMatch = messageBody.match(/[\w.-]+@[\w.-]+\.\w+/);
            if (emailMatch) state.data.email = emailMatch[0];
            await createTicket(chatId, state.data);
            response = `✅ وصلنا بلاغك!
فريق الدعم بيتواصل معك بأسرع وقت إن شاء الله 🙏💙`;
            state.step = 'completed';
            break;

        // ========== مسار البيع ==========
        case 'sell_timing':
            if (userMessage.includes('قبل') || userMessage === '1') {
                state.data.timing = 'قبل البيع';
                response = `📋 اختر من القائمة عشان نساعدك:

1️⃣ كيف أعرض تذاكري للبيع؟
2️⃣ تذكرتي لم يتم قبولها
3️⃣ لا أرى تذكرتي معروضة
4️⃣ التراجع عن البيع
5️⃣ استفسار ثاني

(أرسل رقم الخيار)`;
                state.step = 'sell_before_options';
            } else if (userMessage.includes('بعد') || userMessage === '2') {
                state.data.timing = 'بعد البيع';
                response = `📋 اختر من القائمة عشان نساعدك:

1️⃣ لم أستلم المبلغ 💰
2️⃣ كيف أرسل التذكرة للمشتري؟
3️⃣ متى يصلني المبلغ؟
4️⃣ حالة التذكرة "لم يستلم"
5️⃣ التراجع عن البيع
6️⃣ مشكلة ثانية

(أرسل رقم الخيار)`;
                state.step = 'sell_after_options';
            } else {
                response = `⚠️ الرجاء اختيار:
1️⃣ قبل البيع
2️⃣ بعد البيع`;
            }
            break;

        case 'sell_before_options':
            let beforeOption = '';
            if (userMessage.includes('عرض') || userMessage === '1') {
                beforeOption = 'كيف أعرض تذاكري للبيع';
                response = `📌 تقدر تعرض تذكرتك بالخطوات التالية:

1️⃣ اضغط على "المزيد"
2️⃣ اختر الفعالية
3️⃣ أكمل البيانات

وتصير تذكرتك معروضة للبيع! 🎫✨

إذا واجهتك أي مشكلة، اكتبها لنا وبنساعدك 💪`;
                state.data.sellOption = beforeOption;
                await createTicket(chatId, state.data);
                state.step = 'completed';
            } else if (userMessage.includes('قبول') || userMessage === '2') {
                beforeOption = 'تذكرتي لم يتم قبولها';
                response = `💬 ابشر! اكتب لنا تفاصيل التذكرة وإيميلك المسجل بالمنصة وبنحل الموضوع 💪`;
                state.data.sellOption = beforeOption;
                state.step = 'sell_describe_issue';
            } else if (userMessage.includes('أرى') || userMessage.includes('ارى') || userMessage === '3') {
                beforeOption = 'لا أرى تذكرتي معروضة';
                response = `✅ لا تشيل هم!

إذا حالة التذكرة "نشطة" يعني هي معروضة للعملاء ويشوفونها 👀🎫

إذا مع ذلك ما تظهر، أرسل لنا إيميلك واسم الفعالية وبنتحقق 💙`;
                state.data.sellOption = beforeOption;
                await createTicket(chatId, state.data);
                state.step = 'completed';
            } else if (userMessage.includes('تراجع') || userMessage === '4') {
                beforeOption = 'التراجع عن البيع';
                response = `⚠️ للأسف ما يمكن التراجع عن البيع إلا إذا فيه مشكلة بالتذكرة نفسها.

إذا عندك مشكلة اكتب لنا التفاصيل وبنساعدك 💙`;
                state.data.sellOption = beforeOption;
                state.step = 'sell_describe_issue';
            } else if (userMessage === '5' || userMessage.includes('ثاني')) {
                beforeOption = 'استفسار ثاني';
                response = `📝 ابشر! اكتب لنا استفسارك وبنساعدك 💪`;
                state.data.sellOption = beforeOption;
                state.step = 'sell_describe_issue';
            } else {
                response = `⚠️ الرجاء اختيار رقم من 1 إلى 5`;
            }
            break;

        case 'sell_describe_issue':
            state.data.userProblem = messageBody;
            const sellEmailMatch = messageBody.match(/[\w.-]+@[\w.-]+\.\w+/);
            if (sellEmailMatch) state.data.email = sellEmailMatch[0];
            await createTicket(chatId, state.data);
            response = `✅ وصلنا طلبك!
بنتواصل معك في أقرب وقت إن شاء الله 🙏💙`;
            state.step = 'completed';
            break;

        // ========== مسار البيع - بعد البيع ==========
        case 'sell_after_options':
            let afterOption = '';
            if (userMessage === '1' || (userMessage.includes('استلم') && userMessage.includes('مبلغ'))) {
                afterOption = 'لم أستلم المبلغ';
                response = `💰 يتم تحويل المبلغ خلال 24 إلى 48 ساعة من إتمام البيع ⏳

إذا تجاوزت المدة، أرسل لنا إيميلك المسجل + رقم الطلب وبنتابع لك 💪`;
                state.data.sellOption = afterOption;
                state.step = 'sell_describe_issue';
            } else if (userMessage === '2' || userMessage.includes('إرسال') || userMessage.includes('ارسال')) {
                afterOption = 'كيف أرسل التذكرة للمشتري';
                response = `📤 طريقة إرسال التذاكر:

🔹 إذا الفعالية من webook:
ترسلها من التطبيق مباشرة بعد ما تشوف بيانات المشتري

🔹 إذا منصة ثانية:
ارفق لنا تفاصيل التذكرة وبنرسلها للمشتري 🎫✨`;
                state.data.sellOption = afterOption;
                await createTicket(chatId, state.data);
                state.step = 'completed';
            } else if (userMessage === '3' || userMessage.includes('متى')) {
                afterOption = 'متى يصلني المبلغ';
                response = `💰 لا تشيل هم!

يتم تحويل المبلغ خلال 24 إلى 48 ساعة ⏳
وبيوصلك إن شاء الله 🙏`;
                state.data.sellOption = afterOption;
                await createTicket(chatId, state.data);
                state.step = 'completed';
            } else if (userMessage === '4' || userMessage.includes('حالة') || userMessage.includes('يستلم')) {
                afterOption = 'حالة التذكرة لم يستلم';
                response = `💬 ابشر! اكتب لنا تفاصيل المشكلة + إيميلك المسجل بالمنصة 💪`;
                state.data.sellOption = afterOption;
                state.step = 'sell_describe_issue';
            } else if (userMessage === '5' || userMessage.includes('تراجع')) {
                afterOption = 'التراجع عن البيع';
                response = `⚠️ للأسف ما يمكن التراجع عن البيع إلا إذا فيه مشكلة بالتذكرة نفسها.

إذا عندك مشكلة اكتب لنا التفاصيل وبنساعدك 💙`;
                state.data.sellOption = afterOption;
                state.step = 'sell_describe_issue';
            } else if (userMessage === '6' || userMessage.includes('ثاني') || userMessage.includes('أخرى') || userMessage.includes('اخرى')) {
                afterOption = 'مشكلة ثانية';
                response = `📝 ابشر! اكتب لنا مشكلتك بالتفصيل وبنساعدك 💪`;
                state.data.sellOption = afterOption;
                state.step = 'sell_describe_issue';
            } else {
                response = `⚠️ الرجاء اختيار رقم من 1 إلى 6`;
            }
            break;

        case 'completed':
            response = `✨ أهلاً وسهلاً في قولدن تيكت! 🎫

كيف نقدر نساعدك اليوم؟

1️⃣ شراء تذكرة 🛒
2️⃣ بيع تذكرة 💰
3️⃣ التذكرة ما وصلتني 🎟️
4️⃣ مشكلة في الدفع أو التطبيق 📱
5️⃣ استفسار ثاني ❓

(أرسل رقم الخيار)`;
            state = { step: 'main_choice', data: { contactName, contactPhone }, lastUpdate: Date.now() };
            break;

        default:
            response = `✨ أهلاً وسهلاً في قولدن تيكت! 🎫

كيف نقدر نساعدك اليوم؟

1️⃣ شراء تذكرة 🛒
2️⃣ بيع تذكرة 💰
3️⃣ التذكرة ما وصلتني 🎟️
4️⃣ مشكلة في الدفع أو التطبيق 📱
5️⃣ استفسار ثاني ❓

(أرسل رقم الخيار)`;
            state = { step: 'main_choice', data: { contactName, contactPhone }, lastUpdate: Date.now() };
    }

    // حفظ الحالة
    conversationStates.set(chatId, state);

    return response;
}

// إنشاء تذكرة في النظام
async function createTicket(chatId, data) {
    try {
        // بناء الموضوع من مسار المحادثة
        const subjectParts = [data.mainChoice, data.timing, data.issueType, data.eventType, data.sellOption].filter(Boolean);
        const subject = subjectParts.join(' → ');

        // بناء الوصف من كلام العميل الفعلي
        let description = '';
        if (data.userProblem) {
            description = data.userProblem;
        } else {
            const parts = [data.mainChoice, data.timing, data.issueType, data.eventType, data.eventName, data.sellOption].filter(Boolean);
            description = parts.join(' - ');
        }

        const ticketData = {
            name: data.contactName || 'عميل واتساب',
            phone: data.contactPhone || chatId,
            email: data.email || '',
            subject: subject,
            description: description || 'بلاغ من واتساب',
            category: data.mainChoice || 'استفسار',
            source: 'whatsapp_chatbot'
        };

        // إرسال للـ API
        const response = await fetch(`http://localhost:${PORT}/api/ticket`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': API_KEY
            },
            body: JSON.stringify(ticketData)
        });

        const result = await response.json();
        console.log('✅ Ticket created from chatbot:', result.ticketId);

        // حفظ في Firebase
        if (db) {
            await db.collection('chatbot_tickets').add({
                chatId,
                ticketId: result.ticketId,
                data,
                createdAt: new Date()
            });
        }

        return result;
    } catch (error) {
        console.error('❌ Error creating ticket from chatbot:', error);
        return null;
    }
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
        const prompt = `أنت موظف في قولدن تيكت. حلل بلاغ العميل واكتب ملخص للموظفين.

البلاغ: ${ticketData.subject || ''}

【شراء تذكرة】
• قبل الشراء,[فعالية] → يريد شراء تذكرة للفعالية المذكورة
• بعد الشراء,فعالية إنتهت → اشترى تذكرة لفعالية انتهت ويحتاج مساعدة
• بعد الشراء,فعالية قادمة → اشترى تذكرة لفعالية قادمة وعنده استفسار
• بعد الشراء,فعالية خارج السعودية → اشترى تذكرة لفعالية خارج السعودية

【بيع تذكرة - قبل البيع】
• عرض تذاكري للبيع → يسأل كيف يعرض تذاكره (استلم رد آلي بالخطوات)
• تذكرتي لم يتم قبولها → عرض تذكرته ولم تُقبل ويحتاج مساعدة
• لا أرى تذكرتي معروضه → لا يجد تذكرته معروضة (استلم رد: إذا نشطة فهي معروضة)
• متى يصلني المبلغ → يسأل متى يستلم المبلغ (استلم رد: 24-48 ساعة)
• التراجع عن البيع → يريد التراجع (استلم رد: لايمكن إلا بوجود مشكلة)
• ارسال التذكرة بعد البيع → يسأل كيف يرسل التذكرة للمشتري

【بيع تذكرة - بعد البيع】
• كيفية ارسال التذاكر → باع ويسأل كيف يرسلها
• التراجع عن البيع → باع ويريد التراجع عن البيع
• لم أستلم المبلغ → باع ولم يستلم المبلغ (استلم رد: 24-48 ساعة)
• حالة التذكره لم يستلم → أرسل التذكرة لكن المشتري لم يستلمها
• اخرى → استفسار آخر

اكتب جملة واحدة مختصرة تشرح طلب العميل للموظف.
الرد JSON فقط: {"summary": "..."}`;

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
    let message = `🎫 *بلاغ #${ticket.ticketNumber}*\n`;

    if (ticket.name) message += `\n👤 *الاسم:* ${ticket.name}`;
    if (ticket.phone) message += `\n📱 *الجوال:* ${ticket.phone}`;
    if (ticket.email) message += `\n📧 *الإيميل:* ${ticket.email}`;
    if (ticket.category) message += `\n📌 *التصنيف:* ${ticket.category}`;
    if (ticket.subject) message += `\n📋 *الموضوع:* ${ticket.subject}`;

    if (ticket.summary) {
        message += `\n\n🤖 *ملخص AI:* ${ticket.summary}`;
    }

    if (ticket.description) {
        const desc = ticket.description.length > 300 ? ticket.description.substring(0, 300) + '...' : ticket.description;
        message += `\n\n📝 *التفاصيل:*\n${desc}`;
    }

    message += `\n\n🕐 ${new Date(ticket.createdAt).toLocaleString('ar-SA')}`;

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

// ==================== WEBHOOK للرسائل الواردة ====================

// Ultra Msg Webhook - استقبال الرسائل لحظياً
app.post('/webhook/ultramsg', async (req, res) => {
    try {
        const data = req.body;
        console.log('📨 Webhook received:', JSON.stringify(data).substring(0, 500));

        // التحقق من نوع الـ webhook
        if (data.event_type === 'message_received' || data.data || data.from || data.body !== undefined) {
            const message = data.data || data;
            const fromNumber = message.from || message.sender || '';
            // معالجة fromMe بشكل صحيح (قد يكون string أو boolean أو number)
            const isFromMe = message.fromMe === true || message.fromMe === 'true' || message.fromMe === 1 || message.fromMe === '1';
            const isGroup = message.isGroup === true || message.isGroup === 'true' || (fromNumber && fromNumber.includes('@g.us'));

            console.log('📱 Message details:', {
                from: fromNumber,
                body: message.body?.substring(0, 50),
                fromMe: message.fromMe,
                isFromMe,
                isGroup,
                chatbotEnabled
            });

            // حفظ الرسالة في Firebase
            if (db) {
                const messageDoc = {
                    messageId: message.id || `msg_${Date.now()}`,
                    from: fromNumber,
                    to: message.to || '',
                    body: message.body || '',
                    type: message.type || 'chat',
                    timestamp: message.timestamp ? new Date(message.timestamp * 1000) : new Date(),
                    fromMe: isFromMe,
                    chatId: fromNumber || message.chatId || '',
                    // معلومات الوسائط
                    hasMedia: ['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(message.type),
                    media: message.media || '',
                    mimetype: message.mimetype || '',
                    filename: message.filename || '',
                    // معلومات إضافية
                    pushName: message.pushName || message.notifyName || '',
                    isGroup: isGroup,
                    receivedAt: new Date().toISOString()
                };

                await db.collection('whatsapp_messages').add(messageDoc);
                console.log('✅ Message saved to Firebase:', messageDoc.from, messageDoc.body.substring(0, 50));
            }

            // ========== نظام Chatbot قولدن تيكت ==========
            // لا نرد على:
            // - رسائلنا نحن (fromMe)
            // - رسائل المجموعات
            // - إذا كان الـ chatbot معطل

            console.log('🔍 Chatbot check:', {
                chatbotEnabled,
                isFromMe,
                isGroup,
                hasFromNumber: !!fromNumber,
                hasBody: !!message.body,
                shouldProcess: chatbotEnabled && !isFromMe && !isGroup && fromNumber && message.body
            });

            if (chatbotEnabled && !isFromMe && !isGroup && fromNumber && message.body) {
                console.log('✅ Chatbot WILL process this message!');

                // تأخير قبل إرسال الرد
                setTimeout(async () => {
                    try {
                        console.log('🤖 Chatbot processing message from:', fromNumber);

                        const contactName = message.pushName || message.notifyName || '';
                        const contactPhone = fromNumber.replace('@c.us', '');

                        // معالجة الرسالة بالـ Chatbot
                        const botResponse = await handleChatbot(fromNumber, message.body, contactName, contactPhone);
                        console.log('🤖 Bot response:', botResponse?.substring(0, 100));

                        if (botResponse) {
                            const sendResult = await sendWhatsAppMessage(fromNumber, botResponse);
                            console.log('📤 Send result:', sendResult);

                            // حفظ الرد في Firebase
                            if (db) {
                                await db.collection('chatbot_responses').add({
                                    to: fromNumber,
                                    userMessage: message.body,
                                    botResponse: botResponse,
                                    timestamp: new Date()
                                });
                            }
                        }
                    } catch (chatbotError) {
                        console.error('❌ Chatbot error:', chatbotError);
                    }
                }, 1500); // تأخير 1.5 ثانية
            } else {
                console.log('⏭️ Chatbot skipped this message');
            }
        }

        res.status(200).json({ success: true, message: 'Webhook received' });
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(200).json({ success: false, error: error.message });
    }
});

// API لجلب الرسائل المحفوظة من Firebase
app.get('/api/messages', authenticateAdmin, async (req, res) => {
    try {
        if (!db) {
            return res.json({ success: true, messages: [] });
        }

        const chatId = req.query.chatId;
        const limit = parseInt(req.query.limit) || 100;

        let query = db.collection('whatsapp_messages')
            .orderBy('timestamp', 'desc')
            .limit(limit);

        if (chatId) {
            query = db.collection('whatsapp_messages')
                .where('chatId', '==', chatId)
                .orderBy('timestamp', 'desc')
                .limit(limit);
        }

        const snapshot = await query.get();
        const messages = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            timestamp: doc.data().timestamp?.toDate?.() || doc.data().timestamp
        }));

        res.json({ success: true, count: messages.length, messages });
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API لجلب المحادثات الفريدة
app.get('/api/chats', authenticateAdmin, async (req, res) => {
    try {
        if (!db) {
            return res.json({ success: true, chats: [] });
        }

        const snapshot = await db.collection('whatsapp_messages')
            .orderBy('timestamp', 'desc')
            .limit(1000)
            .get();

        // تجميع المحادثات الفريدة
        const chatsMap = new Map();
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const chatId = data.chatId;
            if (chatId && !chatsMap.has(chatId)) {
                chatsMap.set(chatId, {
                    id: chatId,
                    name: data.pushName || chatId.replace('@c.us', '').replace('@g.us', ''),
                    lastMessage: data.body,
                    lastTime: data.timestamp,
                    isGroup: data.isGroup
                });
            }
        });

        res.json({ success: true, chats: Array.from(chatsMap.values()) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        firebase: !!db,
        whatsapp: !!(ULTRAMSG_INSTANCE_ID && ULTRAMSG_TOKEN),
        whatsappGroup: WHATSAPP_GROUP_ID ? 'configured' : 'NOT SET',
        chatbot: chatbotEnabled,
        activeConversations: conversationStates.size,
        openai: !!openai,

        webhook: 'https://ticket-ticket-production.up.railway.app/webhook/ultramsg'
    });
});


// ==================== Gmail API ====================

// بدء عملية ربط Gmail
app.get('/auth/google', (req, res) => {
    if (!gmailOAuth2Client) {
        return res.status(400).json({ success: false, error: 'Gmail not configured' });
    }

    const authUrl = gmailOAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/gmail.readonly'],
        prompt: 'consent'
    });

    res.redirect(authUrl);
});

// استقبال callback من Google
app.get('/auth/google/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
        return res.send(`<h1>❌ خطأ</h1><p>${error}</p><a href="/">الرجوع</a>`);
    }

    if (!code) {
        return res.send('<h1>❌ لم يتم استلام الكود</h1><a href="/">الرجوع</a>');
    }

    try {
        const { tokens } = await gmailOAuth2Client.getToken(code);
        gmailOAuth2Client.setCredentials(tokens);
        gmailTokens = tokens;

        // حفظ الـ tokens في Firebase
        if (db) {
            await db.collection('settings').doc('gmail_tokens').set({
                tokens,
                updatedAt: new Date()
            });
        }

        console.log('✅ Gmail connected successfully');
        res.send(`
            <html dir="rtl">
            <head><title>تم الربط</title></head>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>✅ تم ربط Gmail بنجاح!</h1>
                <p>الآن يمكنك استخدام /api/gmail/check لفحص الإيميلات</p>
                <a href="/">الرجوع للرئيسية</a>
            </body>
            </html>
        `);
    } catch (err) {
        console.error('❌ Gmail auth error:', err);
        res.send(`<h1>❌ خطأ في الربط</h1><p>${err.message}</p><a href="/auth/google">إعادة المحاولة</a>`);
    }
});

// حالة Gmail
app.get('/api/gmail/status', async (req, res) => {
    let connected = false;

    // محاولة تحميل الـ tokens من Firebase
    if (!gmailTokens && db) {
        try {
            const doc = await db.collection('settings').doc('gmail_tokens').get();
            if (doc.exists) {
                gmailTokens = doc.data().tokens;
                gmailOAuth2Client?.setCredentials(gmailTokens);
                connected = true;
            }
        } catch (e) {
            console.log('No saved Gmail tokens');
        }
    } else if (gmailTokens) {
        connected = true;
    }

    res.json({
        success: true,
        configured: !!gmailOAuth2Client,
        connected,
        authUrl: gmailOAuth2Client ? '/auth/google' : null
    });
});

// فحص الإيميلات الجديدة وإرسالها للواتساب
app.get('/api/gmail/check', async (req, res) => {
    if (!gmailOAuth2Client) {
        return res.status(400).json({ success: false, error: 'Gmail not configured' });
    }

    // تحميل الـ tokens من Firebase إذا لم تكن موجودة
    if (!gmailTokens && db) {
        try {
            const doc = await db.collection('settings').doc('gmail_tokens').get();
            if (doc.exists) {
                gmailTokens = doc.data().tokens;
                gmailOAuth2Client.setCredentials(gmailTokens);
            }
        } catch (e) {
            // ignore
        }
    }

    if (!gmailTokens) {
        return res.status(401).json({
            success: false,
            error: 'Gmail غير مربوط',
            authUrl: '/auth/google',
            hint: 'اذهب لـ /auth/google لربط حساب Gmail'
        });
    }

    try {
        gmailOAuth2Client.setCredentials(gmailTokens);
        const gmail = google.gmail({ version: 'v1', auth: gmailOAuth2Client });

        // تحميل الإيميلات المعالجة من Firebase إذا لم تكن محملة
        if (processedEmailIds.size === 0 && db) {
            const sentEmails = await db.collection('gmail_notifications').get();
            sentEmails.forEach(doc => {
                if (doc.data().emailId) {
                    processedEmailIds.add(doc.data().emailId);
                }
            });
        }

        // جلب كل الإيميلات (مقروءة وغير مقروءة) - بدون إيميلات النظام
        const response = await gmail.users.messages.list({
            userId: 'me',
            maxResults: 10,
            q: '-from:noreply'
        });

        const messages = response.data.messages || [];
        const processed = [];

        for (const msg of messages) {
            // تخطي الإيميلات المُرسل عنها إشعار سابقاً
            if (processedEmailIds.has(msg.id)) continue;

            try {
                // جلب تفاصيل الإيميل
                const email = await gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                    format: 'full'
                });

                const headers = email.data.payload.headers;
                const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
                const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
                const date = headers.find(h => h.name === 'Date')?.value || '';

                // فلتر: فقط إيميلات العملاء (الدومينات الشخصية)
                const personalDomains = ['gmail.com', 'hotmail.com', 'yahoo.com', 'outlook.com', 'icloud.com', 'live.com', 'msn.com', 'aol.com', 'protonmail.com', 'ymail.com', 'googlemail.com'];
                const emailMatch = from.match(/@([a-zA-Z0-9.-]+)/);
                const senderDomain = emailMatch ? emailMatch[1].toLowerCase() : '';

                if (!personalDomains.includes(senderDomain)) {
                    // تخطي إيميلات الشركات
                    processedEmailIds.add(msg.id);
                    continue;
                }

                // استخراج الإيميل من الـ from
                const senderEmailMatch = from.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
                const senderEmail = senderEmailMatch ? senderEmailMatch[1].toLowerCase() : '';

                // استخراج محتوى الرسالة
                let body = '';
                const payload = email.data.payload;

                if (payload.body?.data) {
                    body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
                } else if (payload.parts) {
                    for (const part of payload.parts) {
                        if (part.mimeType === 'text/plain' && part.body?.data) {
                            body = Buffer.from(part.body.data, 'base64').toString('utf-8');
                            break;
                        }
                    }
                }

                // استخراج أرقام الجوال من المحتوى
                const phoneMatches = body.match(/(?:\+966|966|05|5)[0-9]{8,9}/g) || [];
                const phones = [...new Set(phoneMatches.map(p => p.replace(/^(\+?966|0)/, '5')))];

                // التحقق من العميل المتكرر
                let isRepeatCustomer = false;
                let repeatInfo = [];

                if (db && senderEmail) {
                    const prevEmails = await db.collection('gmail_notifications')
                        .where('senderEmail', '==', senderEmail)
                        .get();

                    if (!prevEmails.empty) {
                        isRepeatCustomer = true;
                        repeatInfo.push(`الإيميل تواصل ${prevEmails.size} مرة سابقاً`);
                    }
                }

                if (db && phones.length > 0) {
                    for (const phone of phones) {
                        const prevPhones = await db.collection('gmail_notifications')
                            .where('phones', 'array-contains', phone)
                            .get();

                        if (!prevPhones.empty) {
                            isRepeatCustomer = true;
                            repeatInfo.push(`الرقم ${phone} تواصل ${prevPhones.size} مرة سابقاً`);
                        }
                    }
                }

                // تقصير المحتوى إذا كان طويل
                body = body.replace(/<[^>]*>/g, '').trim();
                if (body.length > 500) {
                    body = body.substring(0, 500) + '...';
                }

                // إرسال للواتساب
                if (WHATSAPP_GROUP_ID) {
                    let whatsappMsg = `📧 إيميل جديد!\n\n📤 من: ${from}\n📋 الموضوع: ${subject}\n📅 ${date}`;

                    // إضافة تنبيه العميل المتكرر
                    if (isRepeatCustomer) {
                        whatsappMsg += `\n\n⚠️ *عميل متكرر!*\n${repeatInfo.join('\n')}`;
                    }

                    if (body) {
                        whatsappMsg += `\n\n📝 المحتوى:\n${body}`;
                    }
                    const sendResult = await sendWhatsAppMessage(WHATSAPP_GROUP_ID, whatsappMsg);
                    if (!sendResult) {
                        console.error('❌ Failed to send email notification, will retry later');
                        continue;
                    }
                }

                // حفظ في Firebase فقط بعد نجاح الإرسال
                if (db) {
                    await db.collection('gmail_notifications').add({
                        emailId: msg.id,
                        from,
                        senderEmail,
                        phones,
                        subject,
                        date,
                        isRepeatCustomer,
                        sentToWhatsApp: !!WHATSAPP_GROUP_ID,
                        timestamp: new Date()
                    });
                }

                processed.push({ from, subject, isRepeatCustomer });

                // إضافة للـ Set لمنع التكرار
                processedEmailIds.add(msg.id);

                // تأخير لتجنب rate limiting
                await new Promise(r => setTimeout(r, 500));
            } catch (e) {
                console.error('Error processing email:', e.message);
            }
        }

        res.json({
            success: true,
            checked: messages.length,
            processed: processed.length,
            emails: processed
        });
    } catch (error) {
        console.error('❌ Gmail check error:', error);

        // إذا انتهت صلاحية الـ token
        if (error.message?.includes('invalid_grant') || error.code === 401) {
            gmailTokens = null;
            if (db) {
                await db.collection('settings').doc('gmail_tokens').delete();
            }
            return res.status(401).json({
                success: false,
                error: 'انتهت صلاحية الربط',
                authUrl: '/auth/google',
                hint: 'أعد ربط Gmail من /auth/google'
            });
        }

        res.status(500).json({ success: false, error: error.message });
    }
});

// تحويل الإيميلات القديمة لبلاغات
app.get('/api/gmail/convert-to-tickets', async (req, res) => {
    if (!db) {
        return res.status(500).json({ success: false, error: 'Database not connected' });
    }

    try {
        // جلب كل الإيميلات المسجلة
        const emailsSnapshot = await db.collection('gmail_notifications').get();

        if (emailsSnapshot.empty) {
            return res.json({ success: true, message: 'لا توجد إيميلات قديمة', converted: 0 });
        }

        // جلب البلاغات الموجودة لتجنب التكرار
        const ticketsSnapshot = await db.collection('tickets').where('source', '==', 'gmail').get();
        const existingEmailIds = new Set();
        ticketsSnapshot.docs.forEach(doc => {
            const data = doc.data();
            if (data.emailId) existingEmailIds.add(data.emailId);
        });

        let converted = 0;
        const results = [];

        for (const doc of emailsSnapshot.docs) {
            const email = doc.data();

            // تخطي إذا البلاغ موجود
            if (existingEmailIds.has(email.emailId)) {
                continue;
            }

            try {
                const ticketNumber = await getNextTicketNumber();
                const ticketData = {
                    ticketId: `TKT-${ticketNumber}`,
                    ticketNumber,
                    emailId: email.emailId,
                    name: email.from?.replace(/<.*>/, '').trim() || 'عميل إيميل',
                    email: email.senderEmail || '',
                    phone: email.phones?.length > 0 ? email.phones[0] : '',
                    subject: email.subject || 'بلاغ من إيميل',
                    description: 'تم استيراد هذا البلاغ من إيميل سابق',
                    category: 'إيميل',
                    source: 'gmail',
                    status: 'جديد',
                    priority: email.isRepeatCustomer ? 'عالي' : 'متوسط',
                    isRepeatCustomer: email.isRepeatCustomer || false,
                    createdAt: email.timestamp?.toDate?.()?.toISOString() || new Date().toISOString()
                };

                await db.collection('tickets').doc(ticketData.ticketId).set(ticketData);
                converted++;
                results.push({
                    ticketId: ticketData.ticketId,
                    subject: ticketData.subject,
                    email: ticketData.email
                });
            } catch (err) {
                console.error('Error converting email to ticket:', err.message);
            }
        }

        res.json({
            success: true,
            message: `تم تحويل ${converted} إيميل لبلاغات`,
            converted,
            tickets: results
        });
    } catch (error) {
        console.error('Error converting emails:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// فصل Gmail
app.post('/api/gmail/disconnect', async (req, res) => {
    gmailTokens = null;

    if (db) {
        try {
            await db.collection('settings').doc('gmail_tokens').delete();
        } catch (e) {
            // ignore
        }
    }

    res.json({
        success: true,
        message: 'تم فصل Gmail'
    });
});

// ==================== WhatsApp Chatbot API ====================

// حالة الـ Chatbot
app.get('/api/chatbot/status', async (req, res) => {
    res.json({
        success: true,
        enabled: chatbotEnabled,
        activeConversations: conversationStates.size,
        configured: !!(ULTRAMSG_INSTANCE_ID && ULTRAMSG_TOKEN)
    });
});

// تفعيل/تعطيل الـ Chatbot
app.post('/api/chatbot/toggle', async (req, res) => {
    const { enabled } = req.body;

    if (typeof enabled === 'boolean') {
        chatbotEnabled = enabled;
    } else {
        chatbotEnabled = !chatbotEnabled;
    }

    console.log(`🤖 Chatbot ${chatbotEnabled ? 'enabled' : 'disabled'}`);

    res.json({
        success: true,
        enabled: chatbotEnabled,
        message: `Chatbot ${chatbotEnabled ? 'مفعل' : 'معطل'}`
    });
});

// إعادة تعيين جميع المحادثات
app.post('/api/chatbot/reset', async (req, res) => {
    const count = conversationStates.size;
    conversationStates.clear();

    res.json({
        success: true,
        message: `تم إعادة تعيين ${count} محادثة`,
        cleared: count
    });
});

// إعادة تعيين محادثة معينة
app.post('/api/chatbot/reset/:chatId', async (req, res) => {
    const { chatId } = req.params;
    const fullChatId = chatId.includes('@') ? chatId : `${chatId}@c.us`;

    if (conversationStates.has(fullChatId)) {
        conversationStates.delete(fullChatId);
        res.json({
            success: true,
            message: `تم إعادة تعيين المحادثة: ${fullChatId}`
        });
    } else {
        res.json({
            success: false,
            message: 'المحادثة غير موجودة'
        });
    }
});

// عرض المحادثات النشطة
app.get('/api/chatbot/conversations', async (req, res) => {
    const conversations = [];
    for (const [chatId, state] of conversationStates.entries()) {
        conversations.push({
            chatId,
            step: state.step,
            data: state.data,
            lastUpdate: new Date(state.lastUpdate).toISOString()
        });
    }

    res.json({
        success: true,
        count: conversations.length,
        conversations
    });
});

// جلب سجل ردود الـ Chatbot
app.get('/api/chatbot/logs', async (req, res) => {
    try {
        if (!db) {
            return res.json({ success: true, logs: [] });
        }

        const limit = parseInt(req.query.limit) || 50;
        const snapshot = await db.collection('chatbot_responses')
            .orderBy('timestamp', 'desc')
            .limit(limit)
            .get();

        const logs = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            timestamp: doc.data().timestamp?.toDate?.() || doc.data().timestamp
        }));

        res.json({ success: true, count: logs.length, logs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// اختبار إرسال رسالة
app.post('/api/chatbot/test', async (req, res) => {
    const { to, message } = req.body;

    if (!to) {
        return res.status(400).json({
            success: false,
            error: 'الرجاء تحديد رقم المستلم (to)',
            example: { to: '966501234567@c.us', message: 'رسالة للإرسال' }
        });
    }

    const fullTo = to.includes('@') ? to : `${to}@c.us`;
    const result = await sendWhatsAppMessage(fullTo, message || 'رسالة اختبار من Chatbot');

    if (result) {
        res.json({
            success: true,
            message: 'تم إرسال الرسالة',
            result
        });
    } else {
        res.status(500).json({
            success: false,
            error: 'فشل إرسال الرسالة'
        });
    }
});

// اختبار إرسال رسالة للقروب
app.get('/api/test-send', async (req, res) => {
    try {
        if (!WHATSAPP_GROUP_ID) {
            return res.json({
                success: false,
                error: 'WHATSAPP_GROUP_ID غير محدد في متغيرات البيئة',
                hint: 'أضف WHATSAPP_GROUP_ID في Railway Environment Variables'
            });
        }

        const testMessage = `🔔 رسالة اختبار\n⏰ ${new Date().toLocaleString('ar-SA')}`;

        const response = await fetch(`https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: ULTRAMSG_TOKEN,
                to: WHATSAPP_GROUP_ID,
                body: testMessage
            })
        });

        const data = await response.json();

        res.json({
            success: !data.error,
            groupId: WHATSAPP_GROUP_ID,
            response: data
        });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// جلب البلاغات من رقم معين
app.get('/api/tickets-from/:number', async (req, res) => {
    try {
        if (!db) {
            return res.json({ success: false, error: 'Firebase not connected' });
        }

        const fromNumber = parseInt(req.params.number) || 1;

        const snapshot = await db.collection('tickets')
            .where('ticketNumber', '>=', fromNumber)
            .orderBy('ticketNumber', 'asc')
            .get();

        const tickets = snapshot.docs.map(doc => doc.data());

        res.json({
            success: true,
            fromNumber,
            count: tickets.length,
            tickets
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// اختبار إرسال رسالة لرقم معين
app.get('/api/send-to/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        const message = req.query.msg || `🔔 رسالة اختبار من قولدن تيكت\n⏰ ${new Date().toLocaleString('ar-SA')}`;

        const to = phone.includes('@') ? phone : `${phone}@c.us`;

        const response = await fetch(`https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: ULTRAMSG_TOKEN,
                to: to,
                body: message
            })
        });

        const data = await response.json();

        res.json({
            success: !data.error,
            sentTo: to,
            message: message,
            response: data
        });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==================== أداة تصدير البيانات ====================

// Proxy لجلب البيانات من Ultra Msg مع محاولة جلب الوسائط
app.get('/api/export/chats', async (req, res) => {
    try {
        const response = await fetch(`https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/chats?token=${ULTRAMSG_TOKEN}`);
        const chats = await response.json();
        res.json({ success: true, chats });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// جلب جميع الرسائل مع محاولة جلب روابط الوسائط
app.get('/api/export/messages/:chatId', async (req, res) => {
    try {
        const { chatId } = req.params;
        const limit = parseInt(req.query.limit) || 500;

        // جلب الرسائل
        const response = await fetch(
            `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/chats/messages?token=${ULTRAMSG_TOKEN}&chatId=${chatId}&limit=${limit}`
        );
        const messages = await response.json();

        // محاولة جلب روابط الوسائط للرسائل التي تحتوي على وسائط
        const mediaTypes = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'];

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (mediaTypes.includes(msg.type) && !msg.media && msg.id) {
                // محاولة جلب رابط الوسائط
                try {
                    const mediaResponse = await fetch(
                        `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/media?token=${ULTRAMSG_TOKEN}&msgId=${msg.id}`
                    );
                    const mediaData = await mediaResponse.json();
                    if (mediaData.media) {
                        messages[i].media = mediaData.media;
                        messages[i].mediaFetched = true;
                    }
                } catch(e) {
                    // تجاهل الأخطاء
                }
            }
        }

        res.json({ success: true, messages });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// جلب جميع البيانات دفعة واحدة
app.get('/api/export/all', async (req, res) => {
    try {
        const exportData = {
            exportDate: new Date().toISOString(),
            instance: ULTRAMSG_INSTANCE_ID,
            chats: [],
            allMessages: [],
            mediaMessages: [],
            stats: {
                totalChats: 0,
                totalMessages: 0,
                mediaMessages: 0
            }
        };

        // جلب المحادثات
        const chatsResponse = await fetch(
            `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/chats?token=${ULTRAMSG_TOKEN}`
        );
        const chats = await chatsResponse.json();
        exportData.chats = chats;
        exportData.stats.totalChats = chats.length;

        // جلب رسائل كل محادثة
        for (const chat of chats) {
            try {
                const msgsResponse = await fetch(
                    `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/chats/messages?token=${ULTRAMSG_TOKEN}&chatId=${chat.id}&limit=500`
                );
                const msgs = await msgsResponse.json();

                if (Array.isArray(msgs)) {
                    const chatMessages = {
                        chatId: chat.id,
                        chatName: chat.name || chat.id,
                        messageCount: msgs.length,
                        messages: msgs
                    };

                    exportData.allMessages.push(chatMessages);
                    exportData.stats.totalMessages += msgs.length;

                    // جمع رسائل الوسائط
                    const mediaTypes = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'];
                    msgs.forEach(m => {
                        if (mediaTypes.includes(m.type)) {
                            exportData.mediaMessages.push({
                                chatId: chat.id,
                                chatName: chat.name,
                                messageId: m.id,
                                type: m.type,
                                media: m.media || null,
                                timestamp: m.timestamp,
                                body: m.body
                            });
                            exportData.stats.mediaMessages++;
                        }
                    });
                }

                // تأخير لتجنب rate limiting
                await new Promise(r => setTimeout(r, 100));
            } catch(e) {
                console.error(`Error fetching messages for ${chat.id}:`, e.message);
            }
        }

        res.json({ success: true, data: exportData });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// محاولة جلب وسائط رسالة معينة
app.get('/api/export/media/:msgId', async (req, res) => {
    try {
        const { msgId } = req.params;

        // طريقة 1: استخدام messages/media endpoint
        const mediaResponse = await fetch(
            `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/media?token=${ULTRAMSG_TOKEN}&msgId=${msgId}`
        );
        const mediaData = await mediaResponse.json();

        if (mediaData.media) {
            return res.json({ success: true, media: mediaData.media, source: 'messages/media' });
        }

        // طريقة 2: استخدام media endpoint
        const media2Response = await fetch(
            `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/media/${msgId}?token=${ULTRAMSG_TOKEN}`
        );
        const media2Data = await media2Response.json();

        if (media2Data.media || media2Data.url) {
            return res.json({ success: true, media: media2Data.media || media2Data.url, source: 'media/{id}' });
        }

        res.json({ success: false, message: 'لم يتم العثور على رابط الوسائط', response: { mediaData, media2Data } });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Serve export page
app.get('/export', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'export.html'));
});

// Public endpoint للوسائط من Firebase (بدون authentication)
app.get('/api/public/media', async (req, res) => {
    try {
        if (!db) {
            return res.json({ success: true, messages: [] });
        }

        const chatId = req.query.chatId;
        const limit = parseInt(req.query.limit) || 50;

        // استخدام query بسيط بدون composite index
        let query;
        if (chatId) {
            query = db.collection('whatsapp_messages')
                .where('chatId', '==', chatId)
                .limit(limit * 2); // جلب أكثر ثم فلترة
        } else {
            query = db.collection('whatsapp_messages')
                .orderBy('timestamp', 'desc')
                .limit(limit * 2);
        }

        const snapshot = await query.get();

        // فلترة الوسائط يدوياً
        const messages = snapshot.docs
            .map(doc => ({
                id: doc.id,
                messageId: doc.data().messageId,
                type: doc.data().type,
                media: doc.data().media,
                mimetype: doc.data().mimetype,
                filename: doc.data().filename,
                timestamp: doc.data().timestamp?.toDate?.() || doc.data().timestamp,
                from: doc.data().from,
                chatId: doc.data().chatId,
                hasMedia: doc.data().hasMedia,
                body: doc.data().body
            }))
            .filter(m => m.hasMedia && m.media) // فقط الرسائل التي لديها وسائط مع رابط
            .slice(0, limit);

        res.json({ success: true, count: messages.length, messages });
    } catch (error) {
        console.error('Error fetching media:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Webhook logs - آخر الرسائل المستلمة
app.get('/api/public/recent', async (req, res) => {
    try {
        if (!db) {
            return res.json({ success: true, messages: [] });
        }

        const limit = parseInt(req.query.limit) || 20;

        const snapshot = await db.collection('whatsapp_messages')
            .orderBy('timestamp', 'desc')
            .limit(limit)
            .get();

        const messages = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            timestamp: doc.data().timestamp?.toDate?.() || doc.data().timestamp
        }));

        res.json({ success: true, count: messages.length, messages });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve archive page
app.get('/archive', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'archive.html'));
});

// Serve WhatsApp dashboard
app.get('/whatsapp', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'whatsapp.html'));
});

// Terms of Service page (required by Twitter)
app.get('/terms', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>شروط الخدمة - قولدن تيكت</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.8; }
        h1 { color: #d4af37; }
    </style>
</head>
<body>
    <h1>🎫 شروط الخدمة - قولدن تيكت</h1>
    <p>مرحباً بك في قولدن تيكت. باستخدامك لخدماتنا، فإنك توافق على الشروط التالية:</p>
    <h2>1. الخدمة</h2>
    <p>قولدن تيكت هي منصة لبيع وشراء التذاكر للفعاليات.</p>
    <h2>2. المسؤولية</h2>
    <p>نحن نسعى لتقديم أفضل خدمة ممكنة، لكننا غير مسؤولين عن أي خسائر ناتجة عن استخدام الخدمة.</p>
    <h2>3. الاستخدام</h2>
    <p>يجب استخدام الخدمة بشكل قانوني ومسؤول.</p>
    <p>آخر تحديث: يناير 2025</p>
</body>
</html>
    `);
});

// Privacy Policy page (required by Twitter)
app.get('/privacy', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>سياسة الخصوصية - قولدن تيكت</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.8; }
        h1 { color: #d4af37; }
    </style>
</head>
<body>
    <h1>🔒 سياسة الخصوصية - قولدن تيكت</h1>
    <p>نحن في قولدن تيكت نحترم خصوصيتك.</p>
    <h2>1. البيانات التي نجمعها</h2>
    <p>نجمع المعلومات اللازمة لتقديم الخدمة مثل: الاسم، رقم الجوال، البريد الإلكتروني.</p>
    <h2>2. استخدام البيانات</h2>
    <p>نستخدم بياناتك فقط لتقديم الخدمة والتواصل معك بخصوص طلباتك.</p>
    <h2>3. حماية البيانات</h2>
    <p>نتخذ إجراءات أمنية لحماية بياناتك من الوصول غير المصرح به.</p>
    <h2>4. مشاركة البيانات</h2>
    <p>لا نبيع أو نشارك بياناتك مع أطراف ثالثة إلا عند الضرورة لتقديم الخدمة.</p>
    <p>آخر تحديث: يناير 2025</p>
</body>
</html>
    `);
});

// Twitter OAuth callback
app.get('/callback', (req, res) => {
    res.send('Twitter OAuth Callback - Success');
});

// ==================== إعدادات الإشعارات ====================

// جلب إعدادات الإشعارات الحالية
app.get('/api/notification-settings', authenticateAdmin, async (req, res) => {
    try {
        let settings = {
            ultramsg_instance_id: ULTRAMSG_INSTANCE_ID || '',
            ultramsg_token: ULTRAMSG_TOKEN || '',
            whatsapp_group_id: WHATSAPP_GROUP_ID || '',
            gmail_connected: !!(gmailOAuth2Client && db),
            openai_configured: !!openai
        };

        // جلب الإعدادات المحفوظة من Firebase
        if (db) {
            const doc = await db.collection('settings').doc('notification_config').get();
            if (doc.exists) {
                settings = { ...settings, ...doc.data() };
            }
        }

        res.json({ success: true, settings });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// تحديث إعدادات الإشعارات
app.post('/api/notification-settings', authenticateAdmin, async (req, res) => {
    try {
        const { ultramsg_instance_id, ultramsg_token, whatsapp_group_id } = req.body;

        // تحديث المتغيرات في الذاكرة
        if (ultramsg_instance_id) process.env.ULTRAMSG_INSTANCE_ID = ultramsg_instance_id;
        if (ultramsg_token) process.env.ULTRAMSG_TOKEN = ultramsg_token;
        if (whatsapp_group_id) process.env.WHATSAPP_GROUP_ID = whatsapp_group_id;

        // حفظ في Firebase
        if (db) {
            await db.collection('settings').doc('notification_config').set({
                ultramsg_instance_id: ultramsg_instance_id || '',
                ultramsg_token: ultramsg_token || '',
                whatsapp_group_id: whatsapp_group_id || '',
                updatedAt: new Date().toISOString()
            }, { merge: true });
        }

        res.json({ success: true, message: 'تم تحديث الإعدادات بنجاح' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// إعادة إرسال البلاغات من تاريخ معين للقروب
app.get('/api/resend-since', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ success: false, message: 'Firebase غير متصل' });
        }

        // تحديد التاريخ (افتراضياً: الأحد الماضي)
        let sinceDate;
        if (req.query.date) {
            sinceDate = new Date(req.query.date);
        } else {
            // حساب يوم الأحد الماضي
            sinceDate = new Date();
            const dayOfWeek = sinceDate.getDay();
            sinceDate.setDate(sinceDate.getDate() - dayOfWeek);
            sinceDate.setHours(0, 0, 0, 0);
        }

        const instanceId = ULTRAMSG_INSTANCE_ID || process.env.ULTRAMSG_INSTANCE_ID;
        const token = ULTRAMSG_TOKEN || process.env.ULTRAMSG_TOKEN;
        const groupId = WHATSAPP_GROUP_ID || process.env.WHATSAPP_GROUP_ID;

        if (!instanceId || !token || !groupId) {
            return res.status(400).json({
                success: false,
                message: 'إعدادات UltraMsg غير مكتملة',
                missing: {
                    instanceId: !instanceId,
                    token: !token,
                    groupId: !groupId
                }
            });
        }

        // جلب البلاغات من التاريخ المحدد
        const snapshot = await db.collection('tickets')
            .where('createdAt', '>=', sinceDate.toISOString())
            .orderBy('createdAt', 'asc')
            .get();

        const tickets = snapshot.docs.map(doc => doc.data());

        // جلب إشعارات الإيميل أيضاً
        const emailSnapshot = await db.collection('gmail_notifications')
            .where('timestamp', '>=', sinceDate)
            .orderBy('timestamp', 'asc')
            .get();

        const emailNotifications = emailSnapshot.docs.map(doc => doc.data());

        if (tickets.length === 0 && emailNotifications.length === 0) {
            return res.json({
                success: true,
                message: `لا توجد بلاغات أو إشعارات منذ ${sinceDate.toLocaleDateString('ar-SA')}`,
                ticketCount: 0,
                emailCount: 0
            });
        }

        let sentTickets = 0;
        let sentEmails = 0;
        const url = `https://api.ultramsg.com/${instanceId}/messages/chat`;

        // إرسال البلاغات
        for (const ticket of tickets) {
            const message = `🎫 *بلاغ #${ticket.ticketNumber}*\n\n` +
                `👤 *الاسم:* ${ticket.name || 'غير معروف'}\n` +
                `📱 *الجوال:* ${ticket.phone || 'غير متوفر'}\n` +
                `📧 *الإيميل:* ${ticket.email || 'غير متوفر'}\n\n` +
                `📌 *التصنيف:* ${ticket.category || 'غير محدد'}\n` +
                `📋 *الموضوع:* ${ticket.subject || 'بدون موضوع'}\n\n` +
                `━━━━━━━━━━━━━━━\n` +
                `📝 *التفاصيل:*\n${ticket.description || 'لا توجد تفاصيل'}\n` +
                `━━━━━━━━━━━━━━━\n\n` +
                `🕐 ${new Date(ticket.createdAt).toLocaleString('ar-SA')}`;

            try {
                await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, to: groupId, body: message })
                });
                sentTickets++;
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (e) {
                console.error('Error resending ticket:', e.message);
            }
        }

        // إرسال إشعارات الإيميل
        for (const email of emailNotifications) {
            const message = `📧 إيميل (إعادة إرسال)\n\n` +
                `📤 من: ${email.from || 'غير معروف'}\n` +
                `📋 الموضوع: ${email.subject || 'بدون موضوع'}\n` +
                `📅 ${email.date || ''}\n` +
                (email.isRepeatCustomer ? `\n⚠️ *عميل متكرر!*` : '');

            try {
                await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, to: groupId, body: message })
                });
                sentEmails++;
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (e) {
                console.error('Error resending email notification:', e.message);
            }
        }

        res.json({
            success: true,
            message: `تم إرسال ${sentTickets} بلاغ و ${sentEmails} إشعار إيميل للقروب`,
            since: sinceDate.toISOString(),
            ticketCount: sentTickets,
            emailCount: sentEmails,
            totalTickets: tickets.length,
            totalEmails: emailNotifications.length
        });

    } catch (error) {
        console.error('Error resending since:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// صفحة إعدادات الإشعارات
app.get('/notification-settings', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>إعدادات الإشعارات - قولدن تيكت</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #0a0a0a; color: #fff; min-height: 100vh; padding: 20px; }
        .container { max-width: 800px; margin: 0 auto; }
        h1 { color: #d4af37; text-align: center; margin-bottom: 30px; font-size: 24px; }
        .card { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
        .card h2 { color: #d4af37; margin-bottom: 16px; font-size: 18px; }
        .form-group { margin-bottom: 16px; }
        .form-group label { display: block; margin-bottom: 6px; color: #aaa; font-size: 14px; }
        .form-group input { width: 100%; padding: 12px; background: #111; border: 1px solid #444; border-radius: 8px; color: #fff; font-size: 14px; direction: ltr; text-align: left; }
        .form-group input:focus { border-color: #d4af37; outline: none; }
        .btn { padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: bold; transition: 0.3s; }
        .btn-gold { background: #d4af37; color: #000; }
        .btn-gold:hover { background: #e5c548; }
        .btn-green { background: #27ae60; color: #fff; }
        .btn-green:hover { background: #2ecc71; }
        .btn-blue { background: #2980b9; color: #fff; }
        .btn-blue:hover { background: #3498db; }
        .btn-red { background: #c0392b; color: #fff; margin-right: 8px; }
        .btn-red:hover { background: #e74c3c; }
        .btn-group { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
        .status { padding: 10px 16px; border-radius: 8px; margin-top: 12px; font-size: 14px; display: none; }
        .status.success { display: block; background: rgba(39,174,96,0.15); border: 1px solid #27ae60; color: #2ecc71; }
        .status.error { display: block; background: rgba(192,57,43,0.15); border: 1px solid #c0392b; color: #e74c3c; }
        .status.info { display: block; background: rgba(41,128,185,0.15); border: 1px solid #2980b9; color: #3498db; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 12px; }
        .stat { background: #111; border-radius: 8px; padding: 16px; text-align: center; }
        .stat .num { font-size: 28px; font-weight: bold; color: #d4af37; }
        .stat .label { font-size: 12px; color: #888; margin-top: 4px; }
        .back-link { display: inline-block; margin-bottom: 20px; color: #d4af37; text-decoration: none; }
        .back-link:hover { text-decoration: underline; }
        .loading { display: none; text-align: center; padding: 20px; color: #888; }
        .divider { border-top: 1px solid #333; margin: 20px 0; }
    </style>
</head>
<body>
    <div class="container">
        <a href="/" class="back-link">→ الرئيسية</a>
        <h1>⚙️ إعدادات الإشعارات</h1>

        <!-- إعدادات UltraMsg -->
        <div class="card">
            <h2>📱 إعدادات واتساب (UltraMsg)</h2>
            <div class="form-group">
                <label>Instance ID</label>
                <input type="text" id="instanceId" placeholder="مثال: instance100568">
            </div>
            <div class="form-group">
                <label>Token</label>
                <input type="text" id="token" placeholder="التوكن من UltraMsg">
            </div>
            <div class="form-group">
                <label>معرف القروب (Group ID)</label>
                <input type="text" id="groupId" placeholder="مثال: 120363xxxxx@g.us">
            </div>
            <div class="btn-group">
                <button class="btn btn-gold" onclick="saveSettings()">💾 حفظ الإعدادات</button>
                <button class="btn btn-green" onclick="testConnection()">🔗 اختبار الاتصال</button>
            </div>
            <div id="settingsStatus" class="status"></div>
        </div>

        <!-- إعادة إرسال الإشعارات -->
        <div class="card">
            <h2>🔄 إعادة إرسال الإشعارات</h2>
            <p style="color: #aaa; margin-bottom: 12px;">إعادة إرسال جميع البلاغات وإشعارات الإيميل التي لم تُرسل للقروب</p>
            <div class="form-group">
                <label>من تاريخ</label>
                <input type="date" id="sinceDate" style="direction: ltr;">
            </div>
            <div class="btn-group">
                <button class="btn btn-blue" onclick="resendSince()">📤 إعادة الإرسال</button>
                <button class="btn btn-green" onclick="resendLastSunday()">📤 من الأحد الماضي</button>
            </div>
            <div id="resendStatus" class="status"></div>
            <div id="resendLoading" class="loading">جاري إعادة الإرسال... ⏳</div>
        </div>

        <!-- حالة النظام -->
        <div class="card">
            <h2>📊 حالة النظام</h2>
            <div id="systemStats" class="stats">
                <div class="stat"><div class="num" id="statWhatsapp">-</div><div class="label">واتساب</div></div>
                <div class="stat"><div class="num" id="statGmail">-</div><div class="label">إيميل</div></div>
                <div class="stat"><div class="num" id="statFirebase">-</div><div class="label">Firebase</div></div>
            </div>
        </div>
    </div>

    <script>
        const adminKey = prompt('أدخل مفتاح الأدمن:');

        async function loadSettings() {
            try {
                const res = await fetch('/api/notification-settings?key=' + adminKey);
                const data = await res.json();
                if (data.success) {
                    document.getElementById('instanceId').value = data.settings.ultramsg_instance_id || '';
                    document.getElementById('token').value = data.settings.ultramsg_token || '';
                    document.getElementById('groupId').value = data.settings.whatsapp_group_id || '';
                }
            } catch(e) { console.error(e); }

            // حالة النظام
            try {
                const res = await fetch('/api/health');
                const data = await res.json();
                document.getElementById('statWhatsapp').textContent = data.whatsapp ? '✅' : '❌';
                document.getElementById('statGmail').textContent = data.firebase ? '✅' : '❌';
                document.getElementById('statFirebase').textContent = data.firebase ? '✅' : '❌';
            } catch(e) { console.error(e); }

            // تعيين تاريخ الأحد الماضي كافتراضي
            const now = new Date();
            const sunday = new Date(now);
            sunday.setDate(now.getDate() - now.getDay());
            document.getElementById('sinceDate').value = sunday.toISOString().split('T')[0];
        }

        async function saveSettings() {
            const statusEl = document.getElementById('settingsStatus');
            try {
                const res = await fetch('/api/notification-settings?key=' + adminKey, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ultramsg_instance_id: document.getElementById('instanceId').value,
                        ultramsg_token: document.getElementById('token').value,
                        whatsapp_group_id: document.getElementById('groupId').value
                    })
                });
                const data = await res.json();
                statusEl.className = 'status ' + (data.success ? 'success' : 'error');
                statusEl.textContent = data.success ? '✅ تم حفظ الإعدادات بنجاح' : '❌ ' + data.error;
            } catch(e) {
                statusEl.className = 'status error';
                statusEl.textContent = '❌ خطأ في الاتصال';
            }
        }

        async function testConnection() {
            const statusEl = document.getElementById('settingsStatus');
            statusEl.className = 'status info';
            statusEl.textContent = '⏳ جاري اختبار الاتصال...';
            try {
                const res = await fetch('/api/test-send');
                const data = await res.json();
                statusEl.className = 'status ' + (data.success ? 'success' : 'error');
                statusEl.textContent = data.success ? '✅ تم الإرسال بنجاح للقروب!' : '❌ ' + (data.error || 'فشل الإرسال');
            } catch(e) {
                statusEl.className = 'status error';
                statusEl.textContent = '❌ خطأ في الاتصال';
            }
        }

        async function resendSince() {
            const date = document.getElementById('sinceDate').value;
            if (!date) { alert('اختر تاريخ'); return; }
            await doResend('?date=' + date);
        }

        async function resendLastSunday() {
            await doResend('');
        }

        async function doResend(query) {
            const statusEl = document.getElementById('resendStatus');
            const loadingEl = document.getElementById('resendLoading');
            statusEl.className = 'status';
            statusEl.style.display = 'none';
            loadingEl.style.display = 'block';

            try {
                const res = await fetch('/api/resend-since' + query);
                const data = await res.json();
                loadingEl.style.display = 'none';
                statusEl.className = 'status ' + (data.success ? 'success' : 'error');
                if (data.success) {
                    statusEl.textContent = '✅ ' + data.message;
                } else {
                    statusEl.textContent = '❌ ' + (data.message || data.error);
                }
            } catch(e) {
                loadingEl.style.display = 'none';
                statusEl.className = 'status error';
                statusEl.textContent = '❌ خطأ في الاتصال';
            }
        }

        loadSettings();
    </script>
</body>
</html>`);
});

// ==================== إعادة إرسال بلاغات اليوم للقروب ====================
app.get('/api/resend-today', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ success: false, message: 'Firebase غير متصل' });
        }

        // حساب بداية اليوم (توقيت السعودية)
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        todayStart.setHours(0, 0, 0, 0);

        // جلب البلاغات
        const snapshot = await db.collection('tickets')
            .where('createdAt', '>=', todayStart.toISOString())
            .orderBy('createdAt', 'asc')
            .get();

        const tickets = snapshot.docs.map(doc => doc.data());

        if (tickets.length === 0) {
            return res.json({ success: true, message: 'لا توجد بلاغات اليوم', count: 0 });
        }

        // إرسال كل بلاغ للقروب
        let sentCount = 0;
        for (const ticket of tickets) {
            const message = `🎫 *بلاغ #${ticket.ticketNumber}*\n\n` +
                `👤 *الاسم:* ${ticket.name || 'غير معروف'}\n` +
                `📱 *الجوال:* ${ticket.phone || 'غير متوفر'}\n` +
                `📧 *الإيميل:* ${ticket.email || 'غير متوفر'}\n\n` +
                `📌 *التصنيف:* ${ticket.category || 'غير محدد'}\n` +
                `📋 *الموضوع:* ${ticket.subject || 'بدون موضوع'}\n\n` +
                `━━━━━━━━━━━━━━━\n` +
                `📝 *التفاصيل:*\n${ticket.description || 'لا توجد تفاصيل'}\n` +
                `━━━━━━━━━━━━━━━\n\n` +
                `🕐 ${new Date(ticket.createdAt).toLocaleString('ar-SA')}`;

            if (WHATSAPP_GROUP_ID && ULTRAMSG_INSTANCE_ID && ULTRAMSG_TOKEN) {
                const url = `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`;
                await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token: ULTRAMSG_TOKEN,
                        to: WHATSAPP_GROUP_ID,
                        body: message
                    })
                });
                sentCount++;
                // تأخير بسيط بين الرسائل
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        res.json({
            success: true,
            message: `تم إرسال ${sentCount} بلاغ للقروب`,
            count: sentCount,
            tickets: tickets.map(t => ({
                id: t.ticketId,
                name: t.name,
                phone: t.phone,
                subject: t.subject
            }))
        });

    } catch (error) {
        console.error('Error resending tickets:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== نظام تنبيهات فارس ====================

const FARIS_PHONE = '966506510511';
const FARIS_SCHEDULE = {
    0: [ // الأحد
        { time: '08:00', name: 'علم الدم 1', type: 'محاضرة', room: '1202', doctor: 'حسن عبدالله البارقي' },
        { time: '10:00', name: 'أساسيات الإدارة والسلامة في المختبرات الطبية', type: 'عملي', room: 'G-215', doctor: 'بندر سعد الشريف' },
        { time: '14:00', name: 'القيم الاجتماعية في الإسلام', type: 'محاضرة', room: 'قاعة 1404', doctor: 'عبدالله سعيد الذيابي' }
    ],
    1: [ // الإثنين
        { time: '08:00', name: 'الجودة في المختبرات الطبية', type: 'عملي', room: 'G-215', doctor: 'عبدالله عبدالرحمن الغنايم' },
        { time: '12:00', name: 'الجودة في المختبرات الطبية', type: 'محاضرة', room: '1202', doctor: 'عبدالله عبدالرحمن الغنايم' },
        { time: '14:00', name: 'التحرير العربي', type: 'محاضرة', room: 'قاعة 1404', doctor: 'عامر ملحم محمد الحطيري' },
        { time: '17:00', name: 'أساسيات علم المناعة', type: 'محاضرة', room: '1209', doctor: 'محمد الرغوجي' }
    ],
    2: [ // الثلاثاء
        { time: '08:00', name: 'علم الدم 1', type: 'عملي', room: 'G-205', doctor: 'مشعل عبدالله محمد العوض' },
        { time: '10:00', name: 'كيمياء حيوية اكلينيكية 1', type: 'محاضرة', room: 'G-205', doctor: 'حازم محمد محمود حسن' },
        { time: '12:00', name: 'كيمياء حيوية اكلينيكية 1', type: 'عملي', room: 'G-205', doctor: 'حازم محمد محمود حسن' },
        { time: '14:00', name: 'أساسيات الإدارة والسلامة في المختبرات الطبية', type: 'محاضرة', room: '1202', doctor: 'بندر سعد الشريف' }
    ],
    3: [ // الأربعاء
        { time: '12:00', name: 'أساسيات الرعاية الطارئة', type: 'محاضرة', room: '1202', doctor: 'بندر سعد الشريف' },
        { time: '14:00', name: 'أساسيات الرعاية الطارئة', type: 'عملي', room: 'G-208', doctor: 'بندر سعد الشريف' }
    ],
    4: [ // الخميس
        { time: '10:00', name: 'أساسيات علم المناعة', type: 'عملي', room: 'G-188', doctor: 'مشعل عبدالله محمد العوض' }
    ],
    5: [], // الجمعة - إجازة
    6: []  // السبت - إجازة
};

const DAY_NAMES = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

// إرسال تنبيه قبل المحاضرة بساعة
app.get('/api/faris/reminder', async (req, res) => {
    try {
        const now = new Date();
        const dayOfWeek = now.getDay();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();

        const todaySchedule = FARIS_SCHEDULE[dayOfWeek] || [];
        const reminders = [];

        for (const lecture of todaySchedule) {
            const [lectureHour] = lecture.time.split(':').map(Number);
            // تنبيه قبل ساعة
            if (lectureHour - 1 === currentHour && currentMinute < 15) {
                const msg = `🔔 تنبيه محاضرة بعد ساعة!\n\n📚 ${lecture.name}\n📝 ${lecture.type}\n🏫 القاعة: ${lecture.room}\n👨‍🏫 الدكتور: ${lecture.doctor}\n⏰ الساعة: ${lecture.time}\n\n💪 يلا شد حيلك!`;

                await fetch(`https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: ULTRAMSG_TOKEN, to: `${FARIS_PHONE}@c.us`, body: msg })
                });
                reminders.push(lecture.name);
            }
        }

        res.json({ success: true, day: DAY_NAMES[dayOfWeek], reminders });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// إرسال جدول الغد (يُستدعى الساعة 8 مساءً)
app.get('/api/faris/tomorrow', async (req, res) => {
    try {
        const now = new Date();
        const tomorrow = (now.getDay() + 1) % 7;
        const tomorrowSchedule = FARIS_SCHEDULE[tomorrow] || [];

        if (tomorrowSchedule.length === 0) {
            const msg = `🎉 بشرى سارة!\n\nما عندك محاضرات بكرة (${DAY_NAMES[tomorrow]})\n\nاستغل وقتك بالمذاكرة أو الراحة 💙`;
            await fetch(`https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: ULTRAMSG_TOKEN, to: `${FARIS_PHONE}@c.us`, body: msg })
            });
            return res.json({ success: true, day: DAY_NAMES[tomorrow], message: 'إجازة' });
        }

        let msg = `📅 جدولك بكرة (${DAY_NAMES[tomorrow]})\n\n`;
        for (const lecture of tomorrowSchedule) {
            const hour = parseInt(lecture.time.split(':')[0]);
            const period = hour < 12 ? 'ص' : 'م';
            const displayHour = hour > 12 ? hour - 12 : hour;
            msg += `🔹 ${displayHour}:00 ${period} - ${lecture.name} (${lecture.type})\n   📍 ${lecture.room}\n\n`;
        }
        msg += `💪 بالتوفيق يا بطل!`;

        await fetch(`https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: ULTRAMSG_TOKEN, to: `${FARIS_PHONE}@c.us`, body: msg })
        });

        res.json({ success: true, day: DAY_NAMES[tomorrow], lectures: tomorrowSchedule.length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// جدول اليوم
app.get('/api/faris/today', async (req, res) => {
    try {
        const now = new Date();
        const dayOfWeek = now.getDay();
        const todaySchedule = FARIS_SCHEDULE[dayOfWeek] || [];

        if (todaySchedule.length === 0) {
            return res.json({ success: true, day: DAY_NAMES[dayOfWeek], message: 'إجازة', lectures: [] });
        }

        res.json({ success: true, day: DAY_NAMES[dayOfWeek], lectures: todaySchedule });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔑 API Key: ${API_KEY}`);
    console.log(`👤 Admin Key: ${ADMIN_KEY}`);
    console.log(`📱 WhatsApp: ${ULTRAMSG_INSTANCE_ID ? 'Configured' : 'Not configured'}`);
    console.log(`🔥 Firebase: ${db ? 'Connected' : 'Not configured'}`);
    console.log(`🤖 OpenAI: ${openai ? 'Configured' : 'Not configured'}`);
    console.log(`📚 Faris Reminder System: Active`);
});
