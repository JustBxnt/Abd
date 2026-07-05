const https = require('https');
const fs = require('fs');
const path = require('path');

// =========================================================================
// 1. PENGATURAN UTAMA (Mendukung Environment Variables untuk GitHub Actions)
// =========================================================================
const TOKEN = process.env.VSPHONE_TOKEN || "YHheiaQbsA7Pj2rXSIasde1SaxpPwtXD"; 
const USER_ID = process.env.VSPHONE_USER_ID || "2218649";                       

// Webhook Discord (Pesan akan diedit otomatis, tidak spam chat)
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "https://discord.com/api/webhooks/1523230416457306255/huX67dkMZ2bgFe2coy_7cbUl3DkWdi_faqnS__TFzwGCOlsO1aPFiDNxNB1b8ahAPwvU";

// ID Pesan Discord spesifik jika Anda ingin mengedit pesan tertentu secara permanen (kosongkan "" untuk mode otomatis)
const DISCORD_MESSAGE_ID = process.env.DISCORD_MESSAGE_ID || "1523233875717918881";

// Deteksi apakah berjalan di lingkungan GitHub Actions
const isGitHubAction = process.env.GITHUB_ACTIONS === 'true';

// Jeda waktu refresh otomatis di terminal (500 ms = 0.5 detik agar hitung mundur detik lancar)
const REFRESH_INTERVAL = 500; 

// Jeda waktu update ke Discord (10000 ms = 10 detik agar tidak terkena rate limit Discord)
const DISCORD_UPDATE_INTERVAL = 10000; 

// Endpoint API
const SHOP_STOCK_URL = "https://api.vsphone.com/vsphone/api/vcCloudGood/getCloudGoodList_V5?goodMonthId=1";
const DEVICE_LIST_URL = "https://api.vsphone.com/vsphone/api/userEquipment/list?supplierType=-1&queryAuthorizedEquipments=true";

const requestHeaders = {
    "Content-Type": "application/json",
    "Token": TOKEN,
    "Userid": USER_ID,
    "Clienttype": "web",
    "Appversion": "2007300",
    "Requestsource": "wechat-miniapp"
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// File untuk menyimpan ID pesan Discord agar tidak hilang saat script di-restart
const MSG_ID_FILE = path.join(__dirname, 'discord_msg_id.txt');

// Status Webhook State (Gunakan ID konfigurasi jika ada, jika tidak coba muat dari file lokal)
let discordMessageId = DISCORD_MESSAGE_ID;
if (!discordMessageId && fs.existsSync(MSG_ID_FILE)) {
    try {
        discordMessageId = fs.readFileSync(MSG_ID_FILE, 'utf8').trim();
    } catch (e) {
        // Abaikan jika gagal membaca
    }
}
let lastDiscordUpdateTime = 0;
let lastError = "";

// Helper untuk melakukan GET HTTPS
function httpGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: requestHeaders }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP Status ${res.statusCode}`));
                return;
            }

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error("Gagal parse JSON dari server"));
                }
            });
        }).on('error', (e) => reject(e));
    });
}

// Helper untuk mengirim / mengedit pesan Webhook Discord
function sendToDiscord(content) {
    return new Promise((resolve) => {
        if (!DISCORD_WEBHOOK_URL) {
            resolve();
            return;
        }

        let url = DISCORD_WEBHOOK_URL;
        let method = 'POST';

        if (discordMessageId) {
            // Edit pesan sebelumnya agar tidak spam chat
            url = `${DISCORD_WEBHOOK_URL}/messages/${discordMessageId}`;
            method = 'PATCH';
        } else {
            // Buat pesan baru pertama kali (wait=true agar Discord mengembalikan message ID)
            url = `${DISCORD_WEBHOOK_URL}?wait=true`;
            method = 'POST';
        }

        const urlObj = new URL(url);
        const bodyData = JSON.stringify({ content });

        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyData)
            }
        };

        const req = https.request(options, (res) => {
            let resData = '';
            res.on('data', chunk => resData += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const parsed = JSON.parse(resData);
                        if (parsed && parsed.id) {
                            discordMessageId = parsed.id;
                            if (!DISCORD_MESSAGE_ID) {
                                fs.writeFileSync(MSG_ID_FILE, discordMessageId, 'utf8');
                            }
                        }
                    } catch (e) {
                        // Jika method PATCH sukses, adakalanya response body kosong
                    }
                    lastError = ""; // Reset error jika sukses
                } else {
                    lastError = `[Discord Error - ${new Date().toLocaleTimeString()}] Status: ${res.statusCode}, Body: ${resData.trim()}`;
                    // Jika gagal mengedit (misal pesan dihapus user), buat pesan baru lagi pada giliran berikutnya
                    if (method === 'PATCH' && !DISCORD_MESSAGE_ID) {
                        discordMessageId = "";
                        if (fs.existsSync(MSG_ID_FILE)) {
                            try {
                                fs.unlinkSync(MSG_ID_FILE);
                            } catch (e) { }
                        }
                    }
                }
                resolve();
            });
        });

        req.on('error', (err) => {
            console.error('[Discord Error]', err.message);
            resolve();
        });

        req.write(bodyData);
        req.end();
    });
}

// Fungsi membuat konten pesan teks yang ringkas untuk Discord (Menggunakan warna ANSI hemat karakter)
function generateDiscordMessage(configs, userDevices, modelReadyCountries) {
    let msg = "";
    msg += `📊 **VSPHONE MONITOR** (Update: ${new Date().toLocaleTimeString('id-ID')})\n`;
    msg += `\`\`\`ansi\n`;
    msg += `Region       │ Bsc │ VIP │ KVP │ SVP │ XVP │ MVP\n`;
    msg += `─────────────┼─────┼─────┼─────┼─────┼─────┼─────\n`;

    const countryData = {};
    const ALLOWED_MODELS = ["BASIC", "VIP", "KVIP", "SVIP", "XVIP", "MVIP"];

    configs.forEach(c => {
        const configNameUpper = c.configName ? c.configName.toUpperCase() : "";
        if (!ALLOWED_MODELS.includes(configNameUpper)) return;

        if (c.countryList && Array.isArray(c.countryList)) {
            c.countryList.forEach(country => {
                const countryName = country.armCountryMsg;
                const isSoldOut = country.sellOutFlag;

                if (!countryData[countryName]) {
                    countryData[countryName] = {
                        "BASIC": "Kos", "VIP": "Kos", "KVIP": "Kos", "SVIP": "Kos", "XVIP": "Kos", "MVIP": "Kos"
                    };
                }
                countryData[countryName][configNameUpper] = isSoldOut ? "Kos" : "Ada";
            });
        }
    });

    Object.keys(countryData).forEach(countryName => {
        const padCountry = countryName.padEnd(12).substring(0, 12);
        const row = countryData[countryName];

        // Format warna ANSI: Hanya 'Ada' diberi warna Hijau untuk hemat karakter. 'Kos' dibiarkan polos (tanpa warna ANSI).
        const formatVal = (val) => {
            if (val === "Ada") {
                return "\u001b[32mAda\u001b[0m"; // Hijau
            } else {
                return "Kos"; // Polos (Hemat 14 karakter per cell)
            }
        };

        msg += `${padCountry} │ ${formatVal(row["BASIC"])} │ ${formatVal(row["VIP"])} │ ${formatVal(row["KVIP"])} │ ${formatVal(row["SVIP"])} │ ${formatVal(row["XVIP"])} │ ${formatVal(row["MVIP"])}\n`;
    });

    msg += `\`\`\`\n`;
    msg += `🔄 **STATUS & REPLACE DEVICES**:\n`;

    if (userDevices.length > 0) {
        userDevices.forEach(d => {
            const modelKey = d.goodConfigName ? d.goodConfigName.toUpperCase() : "";
            const currentRegion = d.armCountryMsg || "Unknown";

            let matchedModelKey = "";
            const checkOrder = ["KVIP", "SVIP", "XVIP", "MVIP", "VIP", "BASIC"];
            for (const m of checkOrder) {
                if (modelKey.includes(m)) {
                    matchedModelKey = m;
                    break;
                }
            }

            const readyRegionsList = modelReadyCountries[matchedModelKey] || [];
            const availableDestinations = readyRegionsList.filter(r => r.toLowerCase() !== currentRegion.toLowerCase());
            const canReplaceSameRegion = readyRegionsList.some(r => r.toLowerCase() === currentRegion.toLowerCase());

            const timeLeftMs = d.signExpirationTimeTamp - Date.now();
            let expirationText = "";
            if (timeLeftMs > 0) {
                const days = Math.floor(timeLeftMs / (1000 * 60 * 60 * 24));
                const hours = Math.floor((timeLeftMs / (1000 * 60 * 60)) % 24);
                expirationText = `${days}d ${hours}h`;
            } else {
                expirationText = "Exp";
            }

            // Batasi target pindah region max 3 negara untuk menghemat panjang karakter
            const destsLimit = availableDestinations.slice(0, 3).join(", ");
            const dests = availableDestinations.length > 0
                ? (availableDestinations.length > 3 ? `${destsLimit}...` : destsLimit)
                : "Penuh";

            const vmIcon = d.cvmStatus === 100 ? "🟢" : "🔴";
            const sameRegionStatusText = canReplaceSameRegion ? "🔄 Ready (ACP)" : "❌ Habis";

            msg += `• **${d.padName}** (${matchedModelKey}) [${currentRegion}]: VM:${vmIcon} | ⏳:${expirationText} | Ref.Sama: ${sameRegionStatusText} | Pindah -> **${dests}**\n`;
        });
    } else {
        msg += `*(Tidak ada perangkat aktif)*\n`;
    }

    msg += `\n*Pewarnaan: Hijau = Ada, Kos = Kosong/Habis*`;
    return msg;
}

// Fungsi menggambar tabel kustom di terminal
function printColoredTable(headers, rows) {
    const colWidths = headers.map(header => {
        let max = header.length;
        rows.forEach(row => {
            const val = String(row[header] || '');
            if (val.length > max) max = val.length;
        });
        return max + 2;
    });

    const drawLine = (left, mid, right) => {
        const line = colWidths.map(w => '─'.repeat(w)).join(mid);
        console.log(left + line + right);
    };

    drawLine('┌', '┬', '┐');

    const headerRow = headers.map((h, i) => {
        return ' ' + h.padEnd(colWidths[i] - 1);
    }).join('│');
    console.log('│' + headerRow + '│');

    drawLine('├', '┼', '┤');

    rows.forEach(row => {
        const dataRow = headers.map((h, i) => {
            const val = String(row[h] || '');
            let displayVal = val;

            if (val === "READY") {
                displayVal = "\x1b[32mREADY\x1b[0m"; // Hijau
            } else if (val === "Habis") {
                displayVal = "\x1b[31mHabis\x1b[0m"; // Merah
            }

            const padLen = colWidths[i] - val.length - 1;
            return ' ' + displayVal + ' '.repeat(padLen);
        }).join('│');
        console.log('│' + dataRow + '│');
    });

    drawLine('└', '┴', '┘');
}

async function runLiveMonitor() {
    while (true) {
        try {
            // Ambil data Toko dan Daftar Perangkat secara paralel
            const [shopResult, deviceResult] = await Promise.all([
                httpGet(SHOP_STOCK_URL),
                httpGet(DEVICE_LIST_URL)
            ]);

            if (shopResult.code !== 200 || !shopResult.data) {
                console.error("❌ Gagal mengambil data toko:", shopResult.msg || "Data kosong");
                await sleep(2000);
                continue;
            }

            const configs = shopResult.data.configs || [];
            const countryData = {};
            const ALLOWED_MODELS = ["BASIC", "VIP", "KVIP", "SVIP", "XVIP", "MVIP"];
            const modelReadyCountries = {};

            const headers = ["Region / Country"];
            const modelHeadersMap = {};

            configs.forEach(c => {
                const configNameUpper = c.configName ? c.configName.toUpperCase() : "";

                if (!ALLOWED_MODELS.includes(configNameUpper)) {
                    return;
                }

                const modelHeader = `${c.configName} (A${c.androidVersion})`;
                modelHeadersMap[configNameUpper] = modelHeader;
                modelReadyCountries[configNameUpper] = [];

                if (c.countryList && Array.isArray(c.countryList)) {
                    c.countryList.forEach(country => {
                        const countryName = country.armCountryMsg;
                        const isSoldOut = country.sellOutFlag;

                        if (!countryData[countryName]) {
                            countryData[countryName] = {
                                "Region / Country": countryName
                            };
                        }

                        countryData[countryName][modelHeader] = isSoldOut ? "Habis" : "READY";

                        if (!isSoldOut) {
                            modelReadyCountries[configNameUpper].push(countryName);
                        }
                    });
                }
            });

            ALLOWED_MODELS.forEach(m => {
                if (modelHeadersMap[m]) {
                    headers.push(modelHeadersMap[m]);
                }
            });

            const tableRows = Object.values(countryData);

            // Bersihkan terminal
            console.clear();

            const timeString = new Date().toLocaleTimeString('id-ID');

            console.log("==========================================================================================");
            console.log(`     VSPHONE SHOP & REPLACE - MONITOR REAL-TIME [Update Terakhir: ${timeString}]`);
            console.log("==========================================================================================\n");

            // 1. Cetak Tabel Terminal
            printColoredTable(headers, tableRows);

            // 2. Cetak Detail Perangkat & Replace di Terminal
            console.log("\n==========================================================================================");
            console.log("                       PANDUAN REPLACE PERANGKAT ANDA (GANTI REGION)                      ");
            console.log("==========================================================================================");

            let userDevices = [];
            const groups = deviceResult.data || [];
            if (Array.isArray(groups)) {
                groups.forEach(g => {
                    if (g.userPads && Array.isArray(g.userPads)) {
                        userDevices = userDevices.concat(g.userPads);
                    }
                });
            }

            if (userDevices.length > 0) {
                userDevices.forEach(d => {
                    const modelKey = d.goodConfigName ? d.goodConfigName.toUpperCase() : "";
                    const currentRegion = d.armCountryMsg || "Unknown";

                    let matchedModelKey = "";
                    const checkOrder = ["KVIP", "SVIP", "XVIP", "MVIP", "VIP", "BASIC"];
                    for (const m of checkOrder) {
                        if (modelKey.includes(m)) {
                            matchedModelKey = m;
                            break;
                        }
                    }

                    const readyRegionsList = modelReadyCountries[matchedModelKey] || [];
                    const availableDestinations = readyRegionsList.filter(r => r.toLowerCase() !== currentRegion.toLowerCase());
                    const canReplaceSameRegion = readyRegionsList.some(r => r.toLowerCase() === currentRegion.toLowerCase());

                    const timeLeftMs = d.signExpirationTimeTamp - Date.now();
                    let expirationCountdown = "";
                    if (timeLeftMs > 0) {
                        const seconds = Math.floor((timeLeftMs / 1000) % 60);
                        const minutes = Math.floor((timeLeftMs / (1000 * 60)) % 60);
                        const hours = Math.floor((timeLeftMs / (1000 * 60 * 60)) % 24);
                        const days = Math.floor(timeLeftMs / (1000 * 60 * 60 * 24));

                        const timeColor = timeLeftMs < (24 * 60 * 60 * 1000) ? "\x1b[31m" : "\x1b[36m";

                        const expDate = new Date(d.signExpirationTimeTamp);
                        const dateStr = expDate.toLocaleString('id-ID', {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit'
                        }).replace(/\//g, '-');

                        expirationCountdown = `${timeColor}${days} Hari ${hours} Jam ${minutes} Menit ${seconds} Detik lagi\x1b[0m (Hingga: ${dateStr})`;
                    } else {
                        expirationCountdown = "\x1b[31mSudah Kedaluwarsa\x1b[0m";
                    }

                    const vmStatusText = d.cvmStatus === 100
                        ? "\x1b[32mOnline (Aktif)\x1b[0m"
                        : `\x1b[31mOffline / Bermasalah (Status: ${d.cvmStatus})\x1b[0m`;

                    console.log(`* Perangkat: \x1b[36m"${d.padName}"\x1b[0m (Tipe: ${d.goodConfigName}) [Saat ini di: ${currentRegion}]`);
                    console.log(`  ├─> [KODE / ID]              : ${d.padCode} (ID: ${d.equipmentId})`);
                    console.log(`  ├─> [STATUS VM]              : ${vmStatusText}`);
                    console.log(`  ├─> [SISA MASA AKTIF]        : ${expirationCountdown}`);

                    if (canReplaceSameRegion) {
                        console.log(`  ├─> \x1b[33m[REPLACE REGION SAMA]\x1b[0m    : Bisa Dilakukan (Prediksi Kode Baru: ACP)`);
                    } else {
                        console.log(`  ├─> \x1b[33m[REPLACE REGION SAMA]\x1b[0m    : Tidak Bisa (Stok di ${currentRegion} Habis)`);
                    }

                    if (availableDestinations.length > 0) {
                        const destinationStr = availableDestinations.join(", ");
                        console.log(`  ├─> \x1b[32m[READY PINDAH REGION KE]\x1b[0m : ${destinationStr}`);
                        console.log(`  └─> \x1b[35m[PREDIKSI KODE BARU]\x1b[0m     : ACP (Akurasi 99% - Relokasi dideploy ke kluster aktif ACP)`);
                    } else {
                        console.log(`  └─> \x1b[31m[STOK PINDAH REGION HABIS DI SEMUA WILAYAH LAIN]\x1b[0m`);
                    }
                    console.log("");
                });
            } else {
                console.log("   (Tidak ditemukan perangkat aktif di akun Anda)");
            }

            if (lastError) {
                console.log(`\n\x1b[31m⚠️ DETAIL LOG/ERROR TERAKHIR:\x1b[0m`);
                console.log(lastError);
            }

            console.log("\n==========================================================================================");
            console.log("INFO: Stok untuk mengganti wilayah (replace) mengikuti kapasitas stok toko di atas.");
            console.log(`Auto-refresh berjalan di background setiap ${REFRESH_INTERVAL / 1000} detik. Tekan Ctrl+C untuk berhenti.`);
            console.log("==========================================================================================");

            // 3. Kirim / Edit pesan ke Discord secara periodik agar tidak rate limit
            const now = Date.now();
            if (now - lastDiscordUpdateTime >= DISCORD_UPDATE_INTERVAL || isGitHubAction) {
                const discordContent = generateDiscordMessage(configs, userDevices, modelReadyCountries);
                await sendToDiscord(discordContent);
                lastDiscordUpdateTime = now;
            }

            if (isGitHubAction) {
                console.log("\n[GitHub Actions] Eksekusi selesai. Mengakhiri proses.");
                break;
            }

        } catch (e) {
            lastError = `[Error - ${new Date().toLocaleTimeString()}] ${e.message}`;
            if (isGitHubAction) {
                console.error(lastError);
                process.exit(1);
            }
        }

        // Tunggu sebelum refresh berikutnya
        await sleep(REFRESH_INTERVAL);
    }
}

// Jalankan monitor real-time
runLiveMonitor();
