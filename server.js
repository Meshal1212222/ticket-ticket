require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
const OpenAI = require('openai');
const { TwitterApi } = require('twitter-api-v2');

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

// Twitter/X Configuration
const TWITTER_API_KEY = process.env.TWITTER_API_KEY;
const TWITTER_API_SECRET = process.env.TWITTER_API_SECRET;
const TWITTER_ACCESS_TOKEN = process.env.TWITTER_ACCESS_TOKEN;
const TWITTER_ACCESS_SECRET = process.env.TWITTER_ACCESS_SECRET;
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;

let twitterClient = null;
let twitterReadOnly = null;

if (TWITTER_API_KEY && TWITTER_API_SECRET && TWITTER_ACCESS_TOKEN && TWITTER_ACCESS_SECRET) {
    try {
        twitterClient = new TwitterApi({
            appKey: TWITTER_API_KEY,
            appSecret: TWITTER_API_SECRET,
            accessToken: TWITTER_ACCESS_TOKEN,
            accessSecret: TWITTER_ACCESS_SECRET,
        });
        twitterReadOnly = twitterClient.readOnly;
        console.log('✅ Twitter configured');
    } catch (error) {
        console.error('❌ Twitter config error:', error.message);
    }
} else {
    console.log('⚠️ Twitter not configured - missing credentials');
}

// إعدادات الرد التلقائي على تويتر
let twitterAutoReplyEnabled = false;
let twitterAutoReplyMessage = 'شكراً لتواصلك! سنرد عليك قريباً 🙏';
let lastCheckedMentionId = null;
let lastCheckedDMId = null;
let twitterDMChatbotEnabled = true; // شات بوت الرسائل الخاصة مفعل افتراضياً

// تتبع حالة محادثات تويتر DM
const twitterConversationStates = new Map();

// ==================== نظام Chatbot قولدن تيكت ====================
let chatbotEnabled = true; // مفعل افتراضياً

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
            // رسالة الترحيب الأولى
            response = `✨ أهلاً وسهلاً في قولدن تيكت! 🎫

كيف نقدر نساعدك اليوم؟

1️⃣ شراء تذكرة
2️⃣ بيع تذكرة

(أرسل رقم الخيار)`;
            state.step = 'main_choice';
            break;

        case 'main_choice':
            if (userMessage.includes('شراء') || userMessage.includes('1')) {
                state.data.mainChoice = 'شراء تذكرة';
                response = `🛒 استفسارك قبل ولا بعد شراء التذكرة؟

1️⃣ قبل الشراء
2️⃣ بعد الشراء

(أرسل رقم الخيار)`;
                state.step = 'buy_timing';
            } else if (userMessage.includes('بيع') || userMessage.includes('2')) {
                state.data.mainChoice = 'بيع تذكرة';
                response = `💰 استفسارك قبل ولا بعد بيع التذكرة؟

1️⃣ قبل البيع
2️⃣ بعد البيع

(أرسل رقم الخيار)`;
                state.step = 'sell_timing';
            } else {
                response = `⚠️ عذراً، لم أفهم اختيارك

الرجاء اختيار:
1️⃣ شراء تذكرة
2️⃣ بيع تذكرة`;
            }
            break;

        // ========== مسار الشراء ==========
        case 'buy_timing':
            if (userMessage.includes('قبل') || userMessage.includes('1')) {
                state.data.timing = 'قبل الشراء';
                response = `🎯 ابشر! وش اسم الفعالية اللي تبي تشتري تذكرة لها؟`;
                state.step = 'buy_event_name';
            } else if (userMessage.includes('بعد') || userMessage.includes('2')) {
                state.data.timing = 'بعد الشراء';
                response = `⚡ طيب، استفسارك يخص فعالية:

1️⃣ فعالية إنتهت
2️⃣ فعالية قادمة
3️⃣ فعالية خارج السعودية

(أرسل رقم الخيار)`;
                state.step = 'buy_event_type';
            } else {
                response = `⚠️ الرجاء اختيار:
1️⃣ قبل الشراء
2️⃣ بعد الشراء`;
            }
            break;

        case 'buy_event_name':
            state.data.eventName = messageBody;
            // إنشاء تذكرة وإرسالها
            await createTicket(chatId, state.data);
            response = `✅ وصلنا طلبك!
بنتواصل معك في أقرب وقت إن شاء الله 🙏💙`;
            state.step = 'completed';
            break;

        case 'buy_event_type':
            if (userMessage.includes('انتهت') || userMessage.includes('إنتهت') || userMessage.includes('1')) {
                state.data.eventType = 'فعالية إنتهت';
            } else if (userMessage.includes('قادمة') || userMessage.includes('2')) {
                state.data.eventType = 'فعالية قادمة';
            } else if (userMessage.includes('خارج') || userMessage.includes('3')) {
                state.data.eventType = 'فعالية خارج السعودية';
            } else {
                response = `⚠️ الرجاء اختيار:
1️⃣ فعالية إنتهت
2️⃣ فعالية قادمة
3️⃣ فعالية خارج السعودية`;
                break;
            }
            response = `📧 لا تشيل هم! بس زودنا بإيميلك المسجل بالمنصة عشان نساعدك 💫`;
            state.step = 'get_email';
            break;

        case 'get_email':
            state.data.email = messageBody;
            await createTicket(chatId, state.data);
            response = `✅ وصلنا طلبك!
بنتواصل معك في أقرب وقت إن شاء الله 🙏💙`;
            state.step = 'completed';
            break;

        // ========== مسار البيع - قبل البيع ==========
        case 'sell_timing':
            if (userMessage.includes('قبل') || userMessage.includes('1')) {
                state.data.timing = 'قبل البيع';
                response = `📋 اختر من القائمة عشان نساعدك:

1️⃣ عرض تذاكري للبيع
2️⃣ تذكرتي لم يتم قبولها
3️⃣ لا أرى تذكرتي معروضة
4️⃣ متى يصلني المبلغ؟
5️⃣ التراجع عن البيع
6️⃣ إرسال التذكرة بعد البيع

(أرسل رقم الخيار)`;
                state.step = 'sell_before_options';
            } else if (userMessage.includes('بعد') || userMessage.includes('2')) {
                state.data.timing = 'بعد البيع';
                response = `📋 اختر من القائمة عشان نساعدك:

1️⃣ كيفية إرسال التذاكر
2️⃣ التراجع عن البيع
3️⃣ لم أستلم المبلغ حتى الآن
4️⃣ حالة التذكرة "لم يستلم"
5️⃣ أخرى

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
            if (userMessage.includes('عرض') || userMessage.includes('1')) {
                beforeOption = 'عرض تذاكري للبيع';
                response = `📌 تقدر تعرض تذكرتك بالخطوات التالية:

1️⃣ اضغط على "المزيد"
2️⃣ اختر الفعالية
3️⃣ أكمل البيانات

وتصير تذكرتك معروضة للبيع! 🎫✨`;
            } else if (userMessage.includes('قبول') || userMessage.includes('2')) {
                beforeOption = 'تذكرتي لم يتم قبولها';
                response = `💬 ابشر! بس زودنا بإيميلك المسجل وبنحل الموضوع 💪`;
                state.data.sellOption = beforeOption;
                state.step = 'get_email';
                break;
            } else if (userMessage.includes('أرى') || userMessage.includes('ارى') || userMessage.includes('3')) {
                beforeOption = 'لا أرى تذكرتي معروضة';
                response = `✅ لا تشيل هم!

إذا حالة التذكرة "نشطة" يعني هي معروضة للعملاء ويشوفونها 👀🎫`;
            } else if (userMessage.includes('مبلغ') || userMessage.includes('4')) {
                beforeOption = 'متى يصلني المبلغ';
                response = `💰 لا تشيل هم!

يتم تحويل المبلغ خلال 24 إلى 48 ساعة ⏳
وبيوصلك إن شاء الله 🙏`;
            } else if (userMessage.includes('تراجع') || userMessage.includes('5')) {
                beforeOption = 'التراجع عن البيع';
                response = `⚠️ للأسف!

ما يمكن التراجع عن البيع إلا إذا فيه مشكلة بالتذكرة نفسها

إذا عندك مشكلة، تواصل معنا وبنساعدك 💙`;
            } else if (userMessage.includes('إرسال') || userMessage.includes('ارسال') || userMessage.includes('6')) {
                beforeOption = 'إرسال التذكرة بعد البيع';
                response = `📤 طريقة إرسال التذاكر:

🔹 إذا الفعالية من webook:
ترسلها من التطبيق مباشرة بعد ما تشوف بيانات المشتري

🔹 إذا منصة ثانية:
ارفق لنا تفاصيل التذكرة وبنرسلها للمشتري 🎫✨`;
            } else {
                response = `⚠️ الرجاء اختيار رقم من 1 إلى 6`;
                break;
            }
            state.data.sellOption = beforeOption;
            await createTicket(chatId, state.data);
            response += `\n\n✅ تم تسجيل استفسارك!`;
            state.step = 'completed';
            break;

        // ========== مسار البيع - بعد البيع ==========
        case 'sell_after_options':
            let afterOption = '';
            if (userMessage.includes('إرسال') || userMessage.includes('ارسال') || userMessage.includes('1')) {
                afterOption = 'كيفية إرسال التذاكر';
                response = `📤 طريقة إرسال التذاكر:

🔹 إذا الفعالية من webook:
ترسلها من التطبيق مباشرة بعد ما تشوف بيانات المشتري

🔹 إذا منصة ثانية:
ارفق لنا تفاصيل التذكرة وبنرسلها للمشتري 🎫✨`;
            } else if (userMessage.includes('تراجع') || userMessage.includes('2')) {
                afterOption = 'التراجع عن البيع';
                response = `⚠️ للأسف!

ما يمكن التراجع عن البيع إلا إذا فيه مشكلة بالتذكرة نفسها

إذا عندك مشكلة، تواصل معنا وبنساعدك 💙`;
            } else if (userMessage.includes('مبلغ') || userMessage.includes('3')) {
                afterOption = 'لم أستلم المبلغ';
                response = `💰 لا تشيل هم!

يتم تحويل المبلغ خلال 24 إلى 48 ساعة ⏳
وبيوصلك إن شاء الله 🙏`;
            } else if (userMessage.includes('حالة') || userMessage.includes('يستلم') || userMessage.includes('4')) {
                afterOption = 'حالة التذكرة لم يستلم';
                response = `📧 لا تشيل هم! بس زودنا بإيميلك المسجل بالمنصة عشان نساعدك 💫`;
                state.data.sellOption = afterOption;
                state.step = 'get_email';
                break;
            } else if (userMessage.includes('أخرى') || userMessage.includes('اخرى') || userMessage.includes('5')) {
                afterOption = 'أخرى';
                response = `📧 لا تشيل هم! بس زودنا بإيميلك المسجل بالمنصة عشان نساعدك 💫`;
                state.data.sellOption = afterOption;
                state.step = 'get_email';
                break;
            } else {
                response = `⚠️ الرجاء اختيار رقم من 1 إلى 5`;
                break;
            }
            state.data.sellOption = afterOption;
            await createTicket(chatId, state.data);
            response += `\n\n✅ تم تسجيل استفسارك!`;
            state.step = 'completed';
            break;

        case 'completed':
            // إذا أرسل رسالة جديدة بعد الانتهاء، نبدأ من جديد
            response = `✨ أهلاً وسهلاً في قولدن تيكت! 🎫

كيف نقدر نساعدك اليوم؟

1️⃣ شراء تذكرة
2️⃣ بيع تذكرة

(أرسل رقم الخيار)`;
            state = { step: 'main_choice', data: { contactName, contactPhone }, lastUpdate: Date.now() };
            break;

        default:
            response = `✨ أهلاً وسهلاً في قولدن تيكت! 🎫

كيف نقدر نساعدك اليوم؟

1️⃣ شراء تذكرة
2️⃣ بيع تذكرة

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
        const subject = [
            data.mainChoice,
            data.timing,
            data.eventType,
            data.eventName,
            data.sellOption,
            data.email
        ].filter(Boolean).join(', ');

        const ticketData = {
            name: data.contactName || 'عميل واتساب',
            phone: data.contactPhone || chatId,
            email: data.email || '',
            subject: subject,
            description: `بلاغ من Chatbot\nالمحادثة: ${chatId}`,
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
        twitter: !!twitterClient,
        twitterAutoReply: twitterAutoReplyEnabled,
        webhook: 'https://ticket-ticket-production.up.railway.app/webhook/ultramsg'
    });
});

// ==================== Twitter/X API ====================

// حالة تويتر
app.get('/api/twitter/status', async (req, res) => {
    res.json({
        configured: !!twitterClient,
        autoReplyEnabled: twitterAutoReplyEnabled,
        autoReplyMessage: twitterAutoReplyMessage,
        lastCheckedMentionId
    });
});

// تفعيل/تعطيل الرد التلقائي
app.post('/api/twitter/auto-reply', async (req, res) => {
    const { enabled, message } = req.body;

    if (typeof enabled === 'boolean') {
        twitterAutoReplyEnabled = enabled;
    }
    if (message) {
        twitterAutoReplyMessage = message;
    }

    res.json({
        success: true,
        autoReplyEnabled: twitterAutoReplyEnabled,
        autoReplyMessage: twitterAutoReplyMessage
    });
});

// جلب المنشنز
app.get('/api/twitter/mentions', async (req, res) => {
    if (!twitterClient) {
        return res.status(400).json({ success: false, error: 'Twitter not configured' });
    }

    try {
        const me = await twitterClient.v2.me();
        const mentions = await twitterClient.v2.userMentionTimeline(me.data.id, {
            max_results: 10,
            'tweet.fields': ['created_at', 'author_id', 'text']
        });

        res.json({
            success: true,
            user: me.data,
            mentions: mentions.data?.data || []
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// إرسال تغريدة
app.post('/api/twitter/tweet', async (req, res) => {
    if (!twitterClient) {
        return res.status(400).json({ success: false, error: 'Twitter not configured' });
    }

    const { text, replyToId } = req.body;

    if (!text) {
        return res.status(400).json({ success: false, error: 'Text is required' });
    }

    try {
        let tweet;
        if (replyToId) {
            tweet = await twitterClient.v2.reply(text, replyToId);
        } else {
            tweet = await twitterClient.v2.tweet(text);
        }

        res.json({ success: true, tweet: tweet.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// الرد على منشن معين
app.post('/api/twitter/reply/:tweetId', async (req, res) => {
    if (!twitterClient) {
        return res.status(400).json({ success: false, error: 'Twitter not configured' });
    }

    const { tweetId } = req.params;
    const { text } = req.body;
    const replyText = text || twitterAutoReplyMessage;

    try {
        const reply = await twitterClient.v2.reply(replyText, tweetId);
        res.json({ success: true, reply: reply.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// فحص المنشنز الجديدة وإرسالها لقروب الواتساب (بدون رد تلقائي)
app.get('/api/twitter/check-and-reply', async (req, res) => {
    if (!twitterClient) {
        return res.status(400).json({ success: false, error: 'Twitter not configured' });
    }

    try {
        const me = await twitterClient.v2.me();
        const mentions = await twitterClient.v2.userMentionTimeline(me.data.id, {
            max_results: 10,
            since_id: lastCheckedMentionId,
            'tweet.fields': ['created_at', 'author_id', 'text']
        });

        const newMentions = mentions.data?.data || [];
        const processed = [];

        for (const mention of newMentions) {
            // لا نعالج منشناتنا نحن
            if (mention.author_id === me.data.id) continue;

            try {
                // تحديث آخر منشن تم فحصه
                if (!lastCheckedMentionId || mention.id > lastCheckedMentionId) {
                    lastCheckedMentionId = mention.id;
                }

                // 1. إرسال إشعار لقروب الواتساب
                if (WHATSAPP_GROUP_ID) {
                    const whatsappMsg = `🐦 منشن جديد من تويتر!\n\n📝 ${mention.text}\n\n🔗 https://twitter.com/i/status/${mention.id}`;
                    await sendWhatsAppMessage(WHATSAPP_GROUP_ID, whatsappMsg);
                }

                // 2. إنشاء تذكرة في النظام
                try {
                    await fetch(`http://localhost:${PORT}/api/ticket`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-API-Key': API_KEY
                        },
                        body: JSON.stringify({
                            name: `Twitter @${mention.author_id}`,
                            subject: mention.text.substring(0, 100),
                            description: `منشن من تويتر:\n${mention.text}\n\nرابط: https://twitter.com/i/status/${mention.id}`,
                            category: 'Twitter',
                            source: 'twitter_mention'
                        })
                    });
                } catch (ticketErr) {
                    console.error('Error creating ticket for mention:', ticketErr.message);
                }

                // 3. حفظ في Firebase
                if (db) {
                    await db.collection('twitter_mentions').add({
                        mentionId: mention.id,
                        mentionText: mention.text,
                        authorId: mention.author_id,
                        sentToWhatsApp: !!WHATSAPP_GROUP_ID,
                        timestamp: new Date()
                    });
                }

                processed.push({
                    mentionId: mention.id,
                    mentionText: mention.text
                });

                // تأخير لتجنب rate limiting
                await new Promise(r => setTimeout(r, 500));
            } catch (e) {
                console.error('Error processing mention:', e.message);
            }
        }

        res.json({
            success: true,
            checked: newMentions.length,
            processed: processed.length,
            sentToWhatsApp: !!WHATSAPP_GROUP_ID,
            mentions: processed
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// اختبار اتصال تويتر
app.get('/api/twitter/test', async (req, res) => {
    if (!twitterClient) {
        return res.json({
            success: false,
            error: 'Twitter not configured',
            hint: 'Add TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET to environment variables'
        });
    }

    try {
        const me = await twitterClient.v2.me();
        res.json({
            success: true,
            user: me.data
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// ==================== Twitter DM Chatbot ====================

// إرسال رسالة خاصة على تويتر
async function sendTwitterDM(userId, message) {
    if (!twitterClient) return null;

    try {
        const result = await twitterClient.v2.sendDmToParticipant(userId, {
            text: message
        });
        console.log('✅ Twitter DM sent to:', userId);
        return result;
    } catch (error) {
        console.error('❌ Error sending Twitter DM:', error.message);
        return null;
    }
}

// معالج الشات بوت لرسائل تويتر الخاصة
async function handleTwitterChatbot(senderId, messageText, senderName) {
    const userMessage = messageText.trim().toLowerCase();
    let state = twitterConversationStates.get(senderId) || { step: 'welcome', data: {}, lastUpdate: Date.now() };

    state.lastUpdate = Date.now();
    state.data.senderName = senderName;
    state.data.senderId = senderId;

    let response = null;

    switch (state.step) {
        case 'welcome':
            response = `✨ أهلاً وسهلاً في قولدن تيكت! 🎫

كيف نقدر نساعدك اليوم؟

1️⃣ شراء تذكرة
2️⃣ بيع تذكرة

(أرسل رقم الخيار)`;
            state.step = 'main_choice';
            break;

        case 'main_choice':
            if (userMessage.includes('شراء') || userMessage.includes('1')) {
                state.data.mainChoice = 'شراء تذكرة';
                response = `🛒 استفسارك قبل ولا بعد شراء التذكرة؟

1️⃣ قبل الشراء
2️⃣ بعد الشراء

(أرسل رقم الخيار)`;
                state.step = 'buy_timing';
            } else if (userMessage.includes('بيع') || userMessage.includes('2')) {
                state.data.mainChoice = 'بيع تذكرة';
                response = `💰 استفسارك قبل ولا بعد بيع التذكرة؟

1️⃣ قبل البيع
2️⃣ بعد البيع

(أرسل رقم الخيار)`;
                state.step = 'sell_timing';
            } else {
                response = `⚠️ عذراً، لم أفهم اختيارك

الرجاء اختيار:
1️⃣ شراء تذكرة
2️⃣ بيع تذكرة`;
            }
            break;

        case 'buy_timing':
            if (userMessage.includes('قبل') || userMessage.includes('1')) {
                state.data.timing = 'قبل الشراء';
                response = `🎯 ابشر! وش اسم الفعالية اللي تبي تشتري تذكرة لها؟`;
                state.step = 'buy_event_name';
            } else if (userMessage.includes('بعد') || userMessage.includes('2')) {
                state.data.timing = 'بعد الشراء';
                response = `⚡ طيب، استفسارك يخص فعالية:

1️⃣ فعالية إنتهت
2️⃣ فعالية قادمة
3️⃣ فعالية خارج السعودية

(أرسل رقم الخيار)`;
                state.step = 'buy_event_type';
            } else {
                response = `⚠️ الرجاء اختيار:
1️⃣ قبل الشراء
2️⃣ بعد الشراء`;
            }
            break;

        case 'buy_event_name':
            state.data.eventName = messageText;
            await createTwitterTicket(senderId, state.data);
            response = `✅ وصلنا طلبك!
بنتواصل معك في أقرب وقت إن شاء الله 🙏💙`;
            state.step = 'completed';
            break;

        case 'buy_event_type':
            if (userMessage.includes('انتهت') || userMessage.includes('إنتهت') || userMessage.includes('1')) {
                state.data.eventType = 'فعالية إنتهت';
            } else if (userMessage.includes('قادمة') || userMessage.includes('2')) {
                state.data.eventType = 'فعالية قادمة';
            } else if (userMessage.includes('خارج') || userMessage.includes('3')) {
                state.data.eventType = 'فعالية خارج السعودية';
            } else {
                response = `⚠️ الرجاء اختيار:
1️⃣ فعالية إنتهت
2️⃣ فعالية قادمة
3️⃣ فعالية خارج السعودية`;
                break;
            }
            response = `📧 لا تشيل هم! بس زودنا بإيميلك المسجل بالمنصة عشان نساعدك 💫`;
            state.step = 'get_email';
            break;

        case 'get_email':
            state.data.email = messageText;
            await createTwitterTicket(senderId, state.data);
            response = `✅ وصلنا طلبك!
بنتواصل معك في أقرب وقت إن شاء الله 🙏💙`;
            state.step = 'completed';
            break;

        case 'sell_timing':
            if (userMessage.includes('قبل') || userMessage.includes('1')) {
                state.data.timing = 'قبل البيع';
                response = `📋 اختر من القائمة عشان نساعدك:

1️⃣ عرض تذاكري للبيع
2️⃣ تذكرتي لم يتم قبولها
3️⃣ لا أرى تذكرتي معروضة
4️⃣ متى يصلني المبلغ؟
5️⃣ التراجع عن البيع
6️⃣ إرسال التذكرة بعد البيع

(أرسل رقم الخيار)`;
                state.step = 'sell_before_options';
            } else if (userMessage.includes('بعد') || userMessage.includes('2')) {
                state.data.timing = 'بعد البيع';
                response = `📋 اختر من القائمة عشان نساعدك:

1️⃣ كيفية إرسال التذاكر
2️⃣ التراجع عن البيع
3️⃣ لم أستلم المبلغ حتى الآن
4️⃣ حالة التذكرة "لم يستلم"
5️⃣ أخرى

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
            if (userMessage.includes('عرض') || userMessage.includes('1')) {
                beforeOption = 'عرض تذاكري للبيع';
                response = `📌 تقدر تعرض تذكرتك بالخطوات التالية:

1️⃣ اضغط على "المزيد"
2️⃣ اختر الفعالية
3️⃣ أكمل البيانات

وتصير تذكرتك معروضة للبيع! 🎫✨`;
            } else if (userMessage.includes('قبول') || userMessage.includes('2')) {
                beforeOption = 'تذكرتي لم يتم قبولها';
                response = `💬 ابشر! بس زودنا بإيميلك المسجل وبنحل الموضوع 💪`;
                state.data.sellOption = beforeOption;
                state.step = 'get_email';
                break;
            } else if (userMessage.includes('أرى') || userMessage.includes('ارى') || userMessage.includes('3')) {
                beforeOption = 'لا أرى تذكرتي معروضة';
                response = `✅ لا تشيل هم!

إذا حالة التذكرة "نشطة" يعني هي معروضة للعملاء ويشوفونها 👀🎫`;
            } else if (userMessage.includes('مبلغ') || userMessage.includes('4')) {
                beforeOption = 'متى يصلني المبلغ';
                response = `💰 لا تشيل هم!

يتم تحويل المبلغ خلال 24 إلى 48 ساعة ⏳
وبيوصلك إن شاء الله 🙏`;
            } else if (userMessage.includes('تراجع') || userMessage.includes('5')) {
                beforeOption = 'التراجع عن البيع';
                response = `⚠️ للأسف!

ما يمكن التراجع عن البيع إلا إذا فيه مشكلة بالتذكرة نفسها

إذا عندك مشكلة، تواصل معنا وبنساعدك 💙`;
            } else if (userMessage.includes('إرسال') || userMessage.includes('ارسال') || userMessage.includes('6')) {
                beforeOption = 'إرسال التذكرة بعد البيع';
                response = `📤 طريقة إرسال التذاكر:

🔹 إذا الفعالية من webook:
ترسلها من التطبيق مباشرة

🔹 إذا منصة ثانية:
ارفق لنا تفاصيل التذكرة وبنرسلها للمشتري 🎫✨`;
            } else {
                response = `⚠️ الرجاء اختيار رقم من 1 إلى 6`;
                break;
            }
            state.data.sellOption = beforeOption;
            await createTwitterTicket(senderId, state.data);
            response += `\n\n✅ تم تسجيل استفسارك!`;
            state.step = 'completed';
            break;

        case 'sell_after_options':
            let afterOption = '';
            if (userMessage.includes('إرسال') || userMessage.includes('ارسال') || userMessage.includes('1')) {
                afterOption = 'كيفية إرسال التذاكر';
                response = `📤 طريقة إرسال التذاكر:

🔹 إذا الفعالية من webook:
ترسلها من التطبيق مباشرة

🔹 إذا منصة ثانية:
ارفق لنا تفاصيل التذكرة وبنرسلها للمشتري 🎫✨`;
            } else if (userMessage.includes('تراجع') || userMessage.includes('2')) {
                afterOption = 'التراجع عن البيع';
                response = `⚠️ للأسف!

ما يمكن التراجع عن البيع إلا إذا فيه مشكلة بالتذكرة نفسها

إذا عندك مشكلة، تواصل معنا وبنساعدك 💙`;
            } else if (userMessage.includes('مبلغ') || userMessage.includes('3')) {
                afterOption = 'لم أستلم المبلغ';
                response = `💰 لا تشيل هم!

يتم تحويل المبلغ خلال 24 إلى 48 ساعة ⏳
وبيوصلك إن شاء الله 🙏`;
            } else if (userMessage.includes('حالة') || userMessage.includes('يستلم') || userMessage.includes('4')) {
                afterOption = 'حالة التذكرة لم يستلم';
                response = `📧 لا تشيل هم! بس زودنا بإيميلك المسجل بالمنصة عشان نساعدك 💫`;
                state.data.sellOption = afterOption;
                state.step = 'get_email';
                break;
            } else if (userMessage.includes('أخرى') || userMessage.includes('اخرى') || userMessage.includes('5')) {
                afterOption = 'أخرى';
                response = `📧 لا تشيل هم! بس زودنا بإيميلك المسجل بالمنصة عشان نساعدك 💫`;
                state.data.sellOption = afterOption;
                state.step = 'get_email';
                break;
            } else {
                response = `⚠️ الرجاء اختيار رقم من 1 إلى 5`;
                break;
            }
            state.data.sellOption = afterOption;
            await createTwitterTicket(senderId, state.data);
            response += `\n\n✅ تم تسجيل استفسارك!`;
            state.step = 'completed';
            break;

        case 'completed':
            response = `✨ أهلاً وسهلاً في قولدن تيكت! 🎫

كيف نقدر نساعدك اليوم؟

1️⃣ شراء تذكرة
2️⃣ بيع تذكرة

(أرسل رقم الخيار)`;
            state = { step: 'main_choice', data: { senderName, senderId }, lastUpdate: Date.now() };
            break;

        default:
            response = `✨ أهلاً وسهلاً في قولدن تيكت! 🎫

كيف نقدر نساعدك اليوم؟

1️⃣ شراء تذكرة
2️⃣ بيع تذكرة

(أرسل رقم الخيار)`;
            state = { step: 'main_choice', data: { senderName, senderId }, lastUpdate: Date.now() };
    }

    twitterConversationStates.set(senderId, state);
    return response;
}

// إنشاء تذكرة من تويتر DM
async function createTwitterTicket(senderId, data) {
    try {
        const subject = [
            data.mainChoice,
            data.timing,
            data.eventType,
            data.eventName,
            data.sellOption,
            data.email
        ].filter(Boolean).join(', ');

        const ticketData = {
            name: data.senderName || `Twitter User ${senderId}`,
            phone: '',
            email: data.email || '',
            subject: subject,
            description: `بلاغ من Twitter DM\nالمرسل: ${senderId}`,
            category: data.mainChoice || 'استفسار',
            source: 'twitter_dm'
        };

        const response = await fetch(`http://localhost:${PORT}/api/ticket`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': API_KEY
            },
            body: JSON.stringify(ticketData)
        });

        const result = await response.json();
        console.log('✅ Ticket created from Twitter DM:', result.ticketId);

        if (db) {
            await db.collection('twitter_dm_tickets').add({
                senderId,
                ticketId: result.ticketId,
                data,
                createdAt: new Date()
            });
        }

        return result;
    } catch (error) {
        console.error('❌ Error creating ticket from Twitter DM:', error);
        return null;
    }
}

// فحص الرسائل الخاصة الجديدة والرد عليها بالشات بوت
app.get('/api/twitter/check-dms', async (req, res) => {
    if (!twitterClient) {
        return res.status(400).json({ success: false, error: 'Twitter not configured' });
    }

    if (!twitterDMChatbotEnabled) {
        return res.json({ success: true, message: 'Twitter DM Chatbot is disabled', processed: 0 });
    }

    try {
        const me = await twitterClient.v2.me();

        // جلب الرسائل الخاصة
        const dmEvents = await twitterClient.v2.listDmEvents({
            max_results: 20,
            'dm_event.fields': ['created_at', 'sender_id', 'text', 'dm_conversation_id']
        });

        const events = dmEvents.data?.data || [];
        const processed = [];

        for (const event of events) {
            // تخطي الرسائل القديمة التي تمت معالجتها
            if (lastCheckedDMId && event.id <= lastCheckedDMId) continue;

            // تخطي رسائلنا نحن
            if (event.sender_id === me.data.id) continue;

            // تخطي إذا لم تكن رسالة نصية
            if (event.event_type !== 'MessageCreate' || !event.text) continue;

            try {
                console.log('📩 Twitter DM from:', event.sender_id, '-', event.text?.substring(0, 50));

                // معالجة الرسالة بالشات بوت
                const botResponse = await handleTwitterChatbot(event.sender_id, event.text, `User ${event.sender_id}`);

                if (botResponse) {
                    // إرسال الرد
                    await sendTwitterDM(event.sender_id, botResponse);

                    // حفظ في Firebase
                    if (db) {
                        await db.collection('twitter_dm_responses').add({
                            senderId: event.sender_id,
                            userMessage: event.text,
                            botResponse: botResponse,
                            timestamp: new Date()
                        });
                    }

                    processed.push({
                        senderId: event.sender_id,
                        message: event.text?.substring(0, 50)
                    });
                }

                // تحديث آخر DM تم فحصه
                if (!lastCheckedDMId || event.id > lastCheckedDMId) {
                    lastCheckedDMId = event.id;
                }

                // تأخير لتجنب rate limiting
                await new Promise(r => setTimeout(r, 1000));
            } catch (e) {
                console.error('Error processing DM:', e.message);
            }
        }

        res.json({
            success: true,
            checked: events.length,
            processed: processed.length,
            messages: processed
        });
    } catch (error) {
        console.error('❌ Error checking Twitter DMs:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// حالة شات بوت تويتر DM
app.get('/api/twitter/dm-chatbot/status', async (req, res) => {
    res.json({
        success: true,
        enabled: twitterDMChatbotEnabled,
        activeConversations: twitterConversationStates.size,
        configured: !!twitterClient
    });
});

// تفعيل/تعطيل شات بوت تويتر DM
app.post('/api/twitter/dm-chatbot/toggle', async (req, res) => {
    const { enabled } = req.body;

    if (typeof enabled === 'boolean') {
        twitterDMChatbotEnabled = enabled;
    } else {
        twitterDMChatbotEnabled = !twitterDMChatbotEnabled;
    }

    console.log(`🐦 Twitter DM Chatbot ${twitterDMChatbotEnabled ? 'enabled' : 'disabled'}`);

    res.json({
        success: true,
        enabled: twitterDMChatbotEnabled,
        message: `Twitter DM Chatbot ${twitterDMChatbotEnabled ? 'مفعل' : 'معطل'}`
    });
});

// إعادة تعيين محادثات تويتر DM
app.post('/api/twitter/dm-chatbot/reset', async (req, res) => {
    const count = twitterConversationStates.size;
    twitterConversationStates.clear();

    res.json({
        success: true,
        message: `تم إعادة تعيين ${count} محادثة تويتر`,
        cleared: count
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

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔑 API Key: ${API_KEY}`);
    console.log(`👤 Admin Key: ${ADMIN_KEY}`);
    console.log(`📱 WhatsApp: ${ULTRAMSG_INSTANCE_ID ? 'Configured' : 'Not configured'}`);
    console.log(`🔥 Firebase: ${db ? 'Connected' : 'Not configured'}`);
    console.log(`🤖 OpenAI: ${openai ? 'Configured' : 'Not configured'}`);
});
