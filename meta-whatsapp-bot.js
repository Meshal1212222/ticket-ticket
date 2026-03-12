// ==================== Golden Ticket - Meta WhatsApp Bot ====================
// بوت واتساب قولدن تيكت عبر Meta Cloud API
// يدعم الأزرار والقوائم التفاعلية

const express = require('express');
const app = express();
app.use(express.json());

// ==================== الإعدادات ====================
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'golden_ticket_verify_2024';
const META_API_URL = `https://graph.facebook.com/v21.0/${META_PHONE_NUMBER_ID}/messages`;

// UltraMsg للإرسال على القروب
const ULTRAMSG_INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID || '';
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN || '';
const WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID || '';

// Firebase
const admin = require('firebase-admin');
let db = null;
try {
    if (process.env.FIREBASE_CONFIG) {
        const config = JSON.parse(process.env.FIREBASE_CONFIG);
        admin.initializeApp({ credential: admin.credential.cert(config) });
        db = admin.firestore();
        console.log('✅ Firebase connected');
    }
} catch (e) {
    console.log('⚠️ Firebase not configured:', e.message);
}

// ==================== حالات المحادثات ====================
const conversations = new Map();

// تنظيف المحادثات القديمة كل 30 دقيقة
setInterval(() => {
    const now = Date.now();
    for (const [id, state] of conversations.entries()) {
        if (now - state.lastUpdate > 30 * 60 * 1000) {
            conversations.delete(id);
        }
    }
}, 30 * 60 * 1000);

// ==================== إرسال الرسائل عبر Meta API ====================

// رسالة نصية عادية
async function sendText(to, text) {
    return await callMetaAPI(to, { type: 'text', text: { body: text } });
}

// رسالة بأزرار (حتى 3 أزرار)
async function sendButtons(to, bodyText, buttons) {
    const btnPayload = buttons.map((btn, i) => ({
        type: 'reply',
        reply: { id: btn.id || `btn_${i}`, title: btn.title.substring(0, 20) }
    }));

    return await callMetaAPI(to, {
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: bodyText },
            action: { buttons: btnPayload }
        }
    });
}

// رسالة بقائمة تفاعلية (حتى 10 اختيارات)
async function sendList(to, bodyText, buttonLabel, items) {
    const rows = items.map((item, i) => ({
        id: item.id || `item_${i}`,
        title: item.title.substring(0, 24),
        description: item.description ? item.description.substring(0, 72) : ''
    }));

    return await callMetaAPI(to, {
        type: 'interactive',
        interactive: {
            type: 'list',
            body: { text: bodyText },
            action: {
                button: buttonLabel.substring(0, 20),
                sections: [{ title: 'الخيارات', rows }]
            }
        }
    });
}

// استدعاء Meta API
async function callMetaAPI(to, messageData) {
    try {
        const response = await fetch(META_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: to,
                ...messageData
            })
        });
        const data = await response.json();
        if (data.error) {
            console.error('❌ Meta API Error:', data.error);
            return null;
        }
        console.log('✅ Message sent to:', to);
        return data;
    } catch (error) {
        console.error('❌ Error calling Meta API:', error.message);
        return null;
    }
}

// إرسال إشعار للقروب عبر UltraMsg
async function sendToGroup(message) {
    if (!ULTRAMSG_INSTANCE_ID || !ULTRAMSG_TOKEN || !WHATSAPP_GROUP_ID) return null;
    try {
        const url = `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: ULTRAMSG_TOKEN, to: WHATSAPP_GROUP_ID, body: message })
        });
        return await response.json();
    } catch (error) {
        console.error('❌ Error sending to group:', error.message);
        return null;
    }
}

// ==================== إنشاء بلاغ ====================
let ticketCounter = 600;

async function getNextTicketNumber() {
    if (db) {
        const ref = db.collection('settings').doc('ticket_counter');
        const doc = await ref.get();
        const current = doc.exists ? doc.data().current : 600;
        await ref.set({ current: current + 1 });
        return current + 1;
    }
    return ++ticketCounter;
}

async function createTicket(phone, data) {
    try {
        const ticketNumber = await getNextTicketNumber();
        const ticket = {
            ticketId: `TKT-${ticketNumber}`,
            ticketNumber,
            name: data.contactName || 'عميل واتساب',
            phone: phone,
            email: data.email || '',
            subject: [data.mainChoice, data.timing, data.issueType, data.sellOption].filter(Boolean).join(' → '),
            description: data.userProblem || '',
            category: data.mainChoice || 'واتساب',
            source: 'meta_whatsapp',
            status: 'جديد',
            priority: 'متوسط',
            createdAt: new Date().toISOString()
        };

        if (db) {
            await db.collection('tickets').doc(ticket.ticketId).set(ticket);
        }

        // إرسال للقروب
        const groupMsg = `🎫 *بلاغ جديد #${ticketNumber}*\n\n` +
            `👤 *الاسم:* ${ticket.name}\n` +
            `📱 *الرقم:* ${phone}\n` +
            `📧 *الإيميل:* ${ticket.email || 'غير متوفر'}\n\n` +
            `📌 *التصنيف:* ${ticket.subject}\n` +
            `━━━━━━━━━━━━━━━\n` +
            `📝 *التفاصيل:*\n${ticket.description || 'لا توجد تفاصيل'}\n` +
            `━━━━━━━━━━━━━━━`;

        await sendToGroup(groupMsg);
        console.log('🎫 Ticket created:', ticket.ticketId);
        return ticket;
    } catch (error) {
        console.error('❌ Error creating ticket:', error.message);
    }
}

// ==================== معالجة المحادثة ====================

async function handleMessage(phone, message) {
    let state = conversations.get(phone) || { step: 'welcome', data: {}, lastUpdate: Date.now() };
    state.lastUpdate = Date.now();
    state.data.contactPhone = phone;

    // استخراج النص أو ID الزر
    let userInput = '';
    let buttonId = '';

    if (message.type === 'interactive') {
        if (message.interactive?.button_reply) {
            buttonId = message.interactive.button_reply.id;
            userInput = message.interactive.button_reply.title;
        } else if (message.interactive?.list_reply) {
            buttonId = message.interactive.list_reply.id;
            userInput = message.interactive.list_reply.title;
        }
    } else if (message.type === 'text') {
        userInput = message.text?.body?.trim() || '';
    }

    const contactName = message.pushName || message.profile_name || '';
    state.data.contactName = contactName || state.data.contactName;

    // ==================== الخطوات ====================

    switch (state.step) {

        // ========== الترحيب ==========
        case 'welcome':
            await sendList(phone,
                `✨ أهلاً وسهلاً في قولدن تيكت! 🎫\n\nكيف نقدر نساعدك اليوم؟`,
                'اختر من القائمة',
                [
                    { id: 'buy', title: 'شراء تذكرة 🛒', description: 'استفسار عن شراء تذاكر' },
                    { id: 'sell', title: 'بيع تذكرة 💰', description: 'استفسار عن بيع تذاكر' },
                    { id: 'not_received', title: 'التذكرة ما وصلتني 🎟️', description: 'مشكلة في استلام التذكرة' },
                    { id: 'payment_app', title: 'مشكلة دفع أو تطبيق 📱', description: 'مشاكل تقنية أو مالية' },
                    { id: 'other', title: 'استفسار ثاني ❓', description: 'أي سؤال أو طلب آخر' }
                ]
            );
            state.step = 'main_choice';
            break;

        // ========== القائمة الرئيسية ==========
        case 'main_choice':
            if (buttonId === 'buy') {
                state.data.mainChoice = 'شراء تذكرة';
                await sendButtons(phone, '🛒 استفسارك قبل ولا بعد شراء التذكرة؟', [
                    { id: 'buy_before', title: 'أبي أشتري تذكرة' },
                    { id: 'buy_after', title: 'اشتريت وعندي مشكلة' }
                ]);
                state.step = 'buy_timing';

            } else if (buttonId === 'sell') {
                state.data.mainChoice = 'بيع تذكرة';
                await sendButtons(phone, '💰 استفسارك قبل ولا بعد بيع التذكرة؟', [
                    { id: 'sell_before', title: 'قبل البيع' },
                    { id: 'sell_after', title: 'بعد البيع' }
                ]);
                state.step = 'sell_timing';

            } else if (buttonId === 'not_received') {
                state.data.mainChoice = 'التذكرة ما وصلت';
                await sendText(phone, '🎟️ لا تشيل هم! عشان نساعدك بأسرع وقت:\n\n📧 أرسل لنا إيميلك المسجل بالمنصة + رقم الطلب إذا عندك');
                state.step = 'ticket_not_received';

            } else if (buttonId === 'payment_app') {
                state.data.mainChoice = 'مشكلة في الدفع أو التطبيق';
                await sendList(phone, '📱 وش المشكلة اللي تواجهك بالضبط؟', 'اختر المشكلة', [
                    { id: 'pay_pending', title: 'الدفع معلق أو ما تم', description: 'مشكلة في عملية الدفع' },
                    { id: 'app_error', title: 'التطبيق فيه خطأ', description: 'التطبيق ما يشتغل أو يعلق' },
                    { id: 'qr_issue', title: 'QR/الباركود ما يظهر', description: 'مشكلة في عرض الباركود' },
                    { id: 'other_issue', title: 'مشكلة ثانية', description: 'أي مشكلة تقنية أخرى' }
                ]);
                state.step = 'app_payment_issue';

            } else if (buttonId === 'other') {
                state.data.mainChoice = 'استفسار عام';
                await sendText(phone, '📝 ابشر! اكتب لنا استفسارك وبنساعدك 💪');
                state.step = 'general_issue';

            } else {
                // لو أرسل نص بدل ما يضغط
                await sendList(phone,
                    '⚠️ الرجاء اختيار من القائمة:',
                    'اختر من القائمة',
                    [
                        { id: 'buy', title: 'شراء تذكرة 🛒', description: 'استفسار عن شراء تذاكر' },
                        { id: 'sell', title: 'بيع تذكرة 💰', description: 'استفسار عن بيع تذاكر' },
                        { id: 'not_received', title: 'التذكرة ما وصلتني 🎟️', description: 'مشكلة في استلام التذكرة' },
                        { id: 'payment_app', title: 'مشكلة دفع أو تطبيق 📱', description: 'مشاكل تقنية أو مالية' },
                        { id: 'other', title: 'استفسار ثاني ❓', description: 'أي سؤال أو طلب آخر' }
                    ]
                );
            }
            break;

        // ========== التذكرة ما وصلت ==========
        case 'ticket_not_received':
            state.data.userProblem = userInput;
            const ticketEmail = userInput.match(/[\w.-]+@[\w.-]+\.\w+/);
            if (ticketEmail) state.data.email = ticketEmail[0];
            await createTicket(phone, state.data);
            await sendText(phone, '✅ وصلنا بلاغك!\n\n⏰ فريق الدعم بيتواصل معك بأسرع وقت إن شاء الله\n\n💡 تقدر تتابع حالة تذكرتك من حسابك بالمنصة 🙏💙');
            state.step = 'completed';
            break;

        // ========== مشاكل الدفع والتطبيق ==========
        case 'app_payment_issue':
            if (buttonId === 'pay_pending') state.data.issueType = 'الدفع معلق أو ما تم';
            else if (buttonId === 'app_error') state.data.issueType = 'التطبيق ما يشتغل';
            else if (buttonId === 'qr_issue') state.data.issueType = 'QR Code ما يظهر';
            else if (buttonId === 'other_issue') state.data.issueType = 'مشكلة أخرى';
            else state.data.issueType = userInput;

            await sendText(phone, '📝 اكتب لنا تفاصيل المشكلة (رقم الطلب + إيميلك المسجل إذا ممكن) 💪');
            state.step = 'app_payment_describe';
            break;

        case 'app_payment_describe':
            state.data.userProblem = userInput;
            const appEmail = userInput.match(/[\w.-]+@[\w.-]+\.\w+/);
            if (appEmail) state.data.email = appEmail[0];
            await createTicket(phone, state.data);
            await sendText(phone, '✅ وصلنا بلاغك!\nفريق الدعم الفني بيتواصل معك بأسرع وقت إن شاء الله 🙏💙');
            state.step = 'completed';
            break;

        // ========== استفسار عام ==========
        case 'general_issue':
            state.data.userProblem = userInput;
            const genEmail = userInput.match(/[\w.-]+@[\w.-]+\.\w+/);
            if (genEmail) state.data.email = genEmail[0];
            await createTicket(phone, state.data);
            await sendText(phone, '✅ وصلنا طلبك!\nبنتواصل معك في أقرب وقت إن شاء الله 🙏💙');
            state.step = 'completed';
            break;

        // ========== مسار الشراء ==========
        case 'buy_timing':
            if (buttonId === 'buy_before') {
                state.data.timing = 'قبل الشراء';
                await sendText(phone, '🎯 ابشر! وش اسم الفعالية اللي تبي تشتري تذكرة لها؟');
                state.step = 'buy_event_name';
            } else if (buttonId === 'buy_after') {
                state.data.timing = 'بعد الشراء';
                await sendList(phone, '⚡ طيب، وش نوع المشكلة؟', 'اختر المشكلة', [
                    { id: 'buy_no_ticket', title: 'التذكرة ما وصلتني', description: 'ما استلمت التذكرة بعد الشراء' },
                    { id: 'buy_wrong', title: 'التذكرة غلط', description: 'التذكرة غلط أو فيها مشكلة' },
                    { id: 'buy_refund', title: 'أبي أسترجع المبلغ', description: 'طلب استرداد المبلغ' },
                    { id: 'buy_other', title: 'مشكلة ثانية', description: 'أي مشكلة أخرى بعد الشراء' }
                ]);
                state.step = 'buy_after_issue';
            } else {
                await sendButtons(phone, '⚠️ الرجاء اختيار:', [
                    { id: 'buy_before', title: 'أبي أشتري تذكرة' },
                    { id: 'buy_after', title: 'اشتريت وعندي مشكلة' }
                ]);
            }
            break;

        case 'buy_event_name':
            state.data.eventName = userInput;
            state.data.userProblem = userInput;
            await createTicket(phone, state.data);
            await sendText(phone, '✅ وصلنا طلبك!\nبنتواصل معك في أقرب وقت إن شاء الله 🙏💙');
            state.step = 'completed';
            break;

        case 'buy_after_issue':
            if (buttonId === 'buy_no_ticket') state.data.issueType = 'التذكرة ما وصلت';
            else if (buttonId === 'buy_wrong') state.data.issueType = 'التذكرة غلط أو فيها مشكلة';
            else if (buttonId === 'buy_refund') state.data.issueType = 'استرجاع مبلغ';
            else if (buttonId === 'buy_other') state.data.issueType = 'مشكلة أخرى';
            else state.data.issueType = userInput;

            await sendText(phone, '📝 لا تشيل هم! اكتب لنا التفاصيل:\n• اسم الفعالية\n• رقم الطلب إذا عندك\n• إيميلك المسجل بالمنصة 💫');
            state.step = 'buy_after_describe';
            break;

        case 'buy_after_describe':
            state.data.userProblem = userInput;
            const buyEmail = userInput.match(/[\w.-]+@[\w.-]+\.\w+/);
            if (buyEmail) state.data.email = buyEmail[0];
            await createTicket(phone, state.data);
            await sendText(phone, '✅ وصلنا بلاغك!\nفريق الدعم بيتواصل معك بأسرع وقت إن شاء الله 🙏💙');
            state.step = 'completed';
            break;

        // ========== مسار البيع ==========
        case 'sell_timing':
            if (buttonId === 'sell_before') {
                state.data.timing = 'قبل البيع';
                await sendList(phone, '📋 اختر من القائمة عشان نساعدك:', 'اختر', [
                    { id: 'sell_how', title: 'كيف أعرض تذاكري؟', description: 'طريقة عرض التذاكر للبيع' },
                    { id: 'sell_rejected', title: 'تذكرتي ما انقبلت', description: 'لم يتم قبول التذكرة' },
                    { id: 'sell_not_shown', title: 'تذكرتي ما تظهر', description: 'لا أرى تذكرتي معروضة' },
                    { id: 'sell_cancel', title: 'التراجع عن البيع', description: 'إلغاء عرض البيع' },
                    { id: 'sell_other_q', title: 'استفسار ثاني', description: 'أي سؤال آخر عن البيع' }
                ]);
                state.step = 'sell_before_options';

            } else if (buttonId === 'sell_after') {
                state.data.timing = 'بعد البيع';
                await sendList(phone, '📋 اختر من القائمة عشان نساعدك:', 'اختر', [
                    { id: 'sell_no_money', title: 'لم أستلم المبلغ 💰', description: 'ما وصلني المبلغ بعد البيع' },
                    { id: 'sell_how_send', title: 'كيف أرسل التذكرة؟', description: 'طريقة إرسال التذكرة للمشتري' },
                    { id: 'sell_when_money', title: 'متى يصلني المبلغ؟', description: 'موعد تحويل المبلغ' },
                    { id: 'sell_not_received', title: 'حالة "لم يستلم"', description: 'التذكرة حالتها لم يستلم' },
                    { id: 'sell_cancel_after', title: 'التراجع عن البيع', description: 'إلغاء البيع بعد الإتمام' },
                    { id: 'sell_other_after', title: 'مشكلة ثانية', description: 'أي مشكلة أخرى' }
                ]);
                state.step = 'sell_after_options';

            } else {
                await sendButtons(phone, '⚠️ الرجاء اختيار:', [
                    { id: 'sell_before', title: 'قبل البيع' },
                    { id: 'sell_after', title: 'بعد البيع' }
                ]);
            }
            break;

        // ========== قبل البيع ==========
        case 'sell_before_options':
            if (buttonId === 'sell_how') {
                state.data.sellOption = 'كيف أعرض تذاكري للبيع';
                await sendText(phone, '📌 تقدر تعرض تذكرتك بالخطوات التالية:\n\n1️⃣ اضغط على "المزيد"\n2️⃣ اختر الفعالية\n3️⃣ أكمل البيانات\n\nوتصير تذكرتك معروضة للبيع! 🎫✨\n\nإذا واجهتك أي مشكلة، اكتبها لنا وبنساعدك 💪');
                await createTicket(phone, state.data);
                state.step = 'completed';

            } else if (buttonId === 'sell_rejected') {
                state.data.sellOption = 'تذكرتي لم يتم قبولها';
                await sendText(phone, '💬 ابشر! اكتب لنا تفاصيل التذكرة وإيميلك المسجل بالمنصة وبنحل الموضوع 💪');
                state.step = 'sell_describe_issue';

            } else if (buttonId === 'sell_not_shown') {
                state.data.sellOption = 'لا أرى تذكرتي معروضة';
                await sendText(phone, '✅ لا تشيل هم!\n\nإذا حالة التذكرة "نشطة" يعني هي معروضة للعملاء ويشوفونها 👀🎫\n\nإذا مع ذلك ما تظهر، أرسل لنا إيميلك واسم الفعالية وبنتحقق 💙');
                await createTicket(phone, state.data);
                state.step = 'completed';

            } else if (buttonId === 'sell_cancel') {
                state.data.sellOption = 'التراجع عن البيع';
                await sendText(phone, '⚠️ للأسف ما يمكن التراجع عن البيع إلا إذا فيه مشكلة بالتذكرة نفسها.\n\nإذا عندك مشكلة اكتب لنا التفاصيل وبنساعدك 💙');
                state.step = 'sell_describe_issue';

            } else if (buttonId === 'sell_other_q') {
                state.data.sellOption = 'استفسار ثاني';
                await sendText(phone, '📝 ابشر! اكتب لنا استفسارك وبنساعدك 💪');
                state.step = 'sell_describe_issue';

            } else {
                await sendText(phone, '⚠️ الرجاء اختيار من القائمة');
            }
            break;

        case 'sell_describe_issue':
            state.data.userProblem = userInput;
            const sellEmail = userInput.match(/[\w.-]+@[\w.-]+\.\w+/);
            if (sellEmail) state.data.email = sellEmail[0];
            await createTicket(phone, state.data);
            await sendText(phone, '✅ وصلنا طلبك!\nبنتواصل معك في أقرب وقت إن شاء الله 🙏💙');
            state.step = 'completed';
            break;

        // ========== بعد البيع ==========
        case 'sell_after_options':
            if (buttonId === 'sell_no_money') {
                state.data.sellOption = 'لم أستلم المبلغ';
                await sendText(phone, '💰 يتم تحويل المبلغ خلال 24 إلى 48 ساعة من إتمام البيع ⏳\n\nإذا تجاوزت المدة، أرسل لنا إيميلك المسجل + رقم الطلب وبنتابع لك 💪');
                state.step = 'sell_describe_issue';

            } else if (buttonId === 'sell_how_send') {
                state.data.sellOption = 'كيف أرسل التذكرة للمشتري';
                await sendText(phone, '📤 طريقة إرسال التذاكر:\n\n🔹 إذا الفعالية من webook:\nترسلها من التطبيق مباشرة بعد ما تشوف بيانات المشتري\n\n🔹 إذا منصة ثانية:\nارفق لنا تفاصيل التذكرة وبنرسلها للمشتري 🎫✨');
                await createTicket(phone, state.data);
                state.step = 'completed';

            } else if (buttonId === 'sell_when_money') {
                state.data.sellOption = 'متى يصلني المبلغ';
                await sendText(phone, '💰 لا تشيل هم!\n\nيتم تحويل المبلغ خلال 24 إلى 48 ساعة ⏳\nوبيوصلك إن شاء الله 🙏');
                await createTicket(phone, state.data);
                state.step = 'completed';

            } else if (buttonId === 'sell_not_received') {
                state.data.sellOption = 'حالة التذكرة لم يستلم';
                await sendText(phone, '💬 ابشر! اكتب لنا تفاصيل المشكلة + إيميلك المسجل بالمنصة 💪');
                state.step = 'sell_describe_issue';

            } else if (buttonId === 'sell_cancel_after') {
                state.data.sellOption = 'التراجع عن البيع';
                await sendText(phone, '⚠️ للأسف ما يمكن التراجع عن البيع إلا إذا فيه مشكلة بالتذكرة نفسها.\n\nإذا عندك مشكلة اكتب لنا التفاصيل وبنساعدك 💙');
                state.step = 'sell_describe_issue';

            } else if (buttonId === 'sell_other_after') {
                state.data.sellOption = 'مشكلة ثانية';
                await sendText(phone, '📝 ابشر! اكتب لنا مشكلتك بالتفصيل وبنساعدك 💪');
                state.step = 'sell_describe_issue';

            } else {
                await sendText(phone, '⚠️ الرجاء اختيار من القائمة');
            }
            break;

        // ========== اكتمال المحادثة ==========
        case 'completed':
            await sendList(phone,
                '✨ أهلاً فيك مرة ثانية! 🎫\n\nكيف نقدر نساعدك؟',
                'اختر من القائمة',
                [
                    { id: 'buy', title: 'شراء تذكرة 🛒', description: 'استفسار عن شراء تذاكر' },
                    { id: 'sell', title: 'بيع تذكرة 💰', description: 'استفسار عن بيع تذاكر' },
                    { id: 'not_received', title: 'التذكرة ما وصلتني 🎟️', description: 'مشكلة في استلام التذكرة' },
                    { id: 'payment_app', title: 'مشكلة دفع أو تطبيق 📱', description: 'مشاكل تقنية أو مالية' },
                    { id: 'other', title: 'استفسار ثاني ❓', description: 'أي سؤال أو طلب آخر' }
                ]
            );
            state = { step: 'main_choice', data: { contactName, contactPhone: phone }, lastUpdate: Date.now() };
            break;

        default:
            await sendList(phone,
                '✨ أهلاً وسهلاً في قولدن تيكت! 🎫\n\nكيف نقدر نساعدك اليوم؟',
                'اختر من القائمة',
                [
                    { id: 'buy', title: 'شراء تذكرة 🛒', description: 'استفسار عن شراء تذاكر' },
                    { id: 'sell', title: 'بيع تذكرة 💰', description: 'استفسار عن بيع تذاكر' },
                    { id: 'not_received', title: 'التذكرة ما وصلتني 🎟️', description: 'مشكلة في استلام التذكرة' },
                    { id: 'payment_app', title: 'مشكلة دفع أو تطبيق 📱', description: 'مشاكل تقنية أو مالية' },
                    { id: 'other', title: 'استفسار ثاني ❓', description: 'أي سؤال أو طلب آخر' }
                ]
            );
            state = { step: 'main_choice', data: { contactName, contactPhone: phone }, lastUpdate: Date.now() };
    }

    conversations.set(phone, state);
}

// ==================== Meta Webhook ====================

// التحقق من الـ Webhook (GET)
app.get('/webhook/meta', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
        console.log('✅ Meta Webhook verified');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// استقبال الرسائل (POST)
app.post('/webhook/meta', async (req, res) => {
    try {
        const body = req.body;

        if (body.object === 'whatsapp_business_account') {
            for (const entry of body.entry || []) {
                for (const change of entry.changes || []) {
                    if (change.field === 'messages') {
                        const value = change.value;

                        // تحديث اسم الشخص
                        const contacts = value.contacts || [];
                        const profileName = contacts[0]?.profile?.name || '';

                        for (const message of value.messages || []) {
                            const phone = message.from;
                            message.profile_name = profileName;

                            console.log('📨 Meta message from:', phone, 'type:', message.type);

                            // علّم الرسالة كمقروءة
                            await callMetaAPI(phone, {});
                            await fetch(META_API_URL, {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    messaging_product: 'whatsapp',
                                    status: 'read',
                                    message_id: message.id
                                })
                            }).catch(() => {});

                            await handleMessage(phone, message);
                        }
                    }
                }
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.sendStatus(200);
    }
});

// ==================== API Endpoints ====================

app.get('/api/bot/status', (req, res) => {
    res.json({
        success: true,
        activeConversations: conversations.size,
        metaConfigured: !!(META_PHONE_NUMBER_ID && META_ACCESS_TOKEN),
        ultramsgConfigured: !!(ULTRAMSG_INSTANCE_ID && ULTRAMSG_TOKEN)
    });
});

app.post('/api/bot/reset', (req, res) => {
    const count = conversations.size;
    conversations.clear();
    res.json({ success: true, message: `تم إعادة تعيين ${count} محادثة`, cleared: count });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== تشغيل السيرفر ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Golden Ticket Meta Bot running on port ${PORT}`);
    console.log(`📱 Meta configured: ${!!(META_PHONE_NUMBER_ID && META_ACCESS_TOKEN)}`);
    console.log(`📤 UltraMsg configured: ${!!(ULTRAMSG_INSTANCE_ID && ULTRAMSG_TOKEN)}`);
});
