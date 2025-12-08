const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const pdfText = require('pdf-extraction'); 

// --- FILES & PATHS ---
const CONFIG_FILE = 'scraper_config.json';
const DB_FILE = 'bid_history_log.json';
const EMAIL_DB_FILE = 'email_master_db.json'; 
const DOWNLOAD_DIR = path.resolve(__dirname, 'gemFile');

// --- LOAD CONFIGURATION ---
let CONFIG = {
    ministryString: "MINISTRY OF PETROLEUM AND NATURAL GAS",
    searchKeywords: ["*"],
    expiryDays: 60,
    inspectionKeywords: ["robotic", "ndt", "visual", "inspection"] 
};

if (fs.existsSync(CONFIG_FILE)) {
    try { CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } 
    catch (e) { console.error("Error loading config, using defaults."); }
}

const EXPIRY_MS = CONFIG.expiryDays * 24 * 60 * 60 * 1000;

// Setup Folders
if (fs.existsSync(DOWNLOAD_DIR)) fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// --- UTILITY: REGEX HELPER ---
const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWholeWord = (text, keyword) => {
    const pattern = `\\b${escapeRegExp(keyword)}\\b`;
    return new RegExp(pattern, 'i').test(text);
};

// --- DATABASE FUNCTIONS ---
function loadDatabase() {
    try { return fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : {}; } 
    catch (e) { return {}; }
}

function saveDatabase(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function pruneDatabase(db) {
    const now = Date.now();
    let changed = false;
    for (const [url, entry] of Object.entries(db)) {
        if (now - (entry.timestamp || 0) > EXPIRY_MS) {
            delete db[url];
            changed = true;
        }
    }
    if (changed) saveDatabase(db);
    return db;
}

function updateEmailDatabase(newEmailList) {
    let emailDb = {};
    if (fs.existsSync(EMAIL_DB_FILE)) {
        try { emailDb = JSON.parse(fs.readFileSync(EMAIL_DB_FILE, 'utf8')); } catch (e) {}
    }
    let changed = false;
    newEmailList.forEach(email => {
        if (!emailDb[email]) {
            emailDb[email] = { email: email, dateAdded: new Date().toISOString(), noOfMailSend: 0, LastMailSended: null };
            changed = true;
        } else if (emailDb[email].noOfMailSend === 4) {
            emailDb[email].noOfMailSend = 3;
            changed = true;
        }
    });
    if (changed) fs.writeFileSync(EMAIL_DB_FILE, JSON.stringify(emailDb, null, 2));
}

// --- ANALYSIS ---
function analyzeTextForInspection(fullText) {
    if (!fullText) return { isInspection: false, summarySnippet: "" };
    let isRelated = false;
    let relevantSentences = [];
    const foundKeywords = CONFIG.inspectionKeywords.filter(kw => hasWholeWord(fullText, kw));
    
    if (foundKeywords.length > 0) {
        isRelated = true;
        const sentences = fullText.split(/(?<=[.!?]|\n)\s+/);
        for (const sentence of sentences) {
            if (foundKeywords.some(kw => hasWholeWord(sentence, kw))) {
                const clean = sentence.replace(/\s+/g, ' ').trim();
                if (clean.length > 15 && clean.length < 500) relevantSentences.push(clean);
            }
            if (relevantSentences.length >= 3) break;
        }
    }
    return { isInspection: isRelated, summarySnippet: relevantSentences.join(' ... ') };
}

// --- DOWNLOAD & EXTRACTION HELPERS ---
async function downloadFile(url, outputPath) {
    try {
        const response = await fetch(url);
        if (!response.ok) return false;
        await pipeline(response.body, fs.createWriteStream(outputPath));
        return true;
    } catch (error) { return false; }
}

async function extractEmailsFromBuffer(dataBuffer) {
    try {
        const data = await pdfText(dataBuffer);
        const text = data.text || "";
        const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi;
        const rawMatches = text.match(emailRegex) || [];
        const cleanedEmails = rawMatches.map(email => email.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
            .filter(email => {
                if (!email.includes('@') || email.length < 5) return false;
                const ext = email.split('.').pop();
                if (/[0-9]/.test(ext)) return false; 
                if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'bmp'].includes(ext)) return false;
                return true;
            });
        return { emails: [...new Set(cleanedEmails)], rawText: text };
    } catch (e) { return { emails: [], rawText: "" }; }
}

async function processPdfFile(filePath) {
    let fullText = "";
    let extractedLinks = new Set();
    const dataBuffer = fs.readFileSync(filePath);

    let mainExtraction = await extractEmailsFromBuffer(dataBuffer);
    fullText = mainExtraction.rawText;
    
    // Hidden Link Extraction
    try {
        const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const doc = await pdfjsLib.getDocument({ data: new Uint8Array(dataBuffer), disableFontFace: true, verbosity: 0 }).promise;
        for (let i = 1; i <= doc.numPages; i++) {
            const annotations = await (await doc.getPage(i)).getAnnotations();
            annotations.forEach(a => { if (a.subtype === 'Link' && a.url) extractedLinks.add(a.url); });
        }
    } catch (e) {}

    const pdfLinks = [...extractedLinks].filter(url => url.toLowerCase().includes('.pdf'));
    const analysis = analyzeTextForInspection(fullText);

    return {
        extracted: { pdfLinks: pdfLinks, emails: mainExtraction.emails },
        isInspection: analysis.isInspection,
        summarySnippet: analysis.summarySnippet
    };
}

// --- WORKER FUNCTION FOR PARALLEL PROCESSING ---
async function processSingleBid(linkObj, page, urlDb) {
    const { href, bidNo } = linkObj;

    if (urlDb[href] && urlDb[href].status === "complete") {
        console.log(`[SKIP] ${bidNo}`);
        return null;
    }

    console.log(`[DOWNLOADING] ${bidNo}`);
    
    // We open a new tab context if needed, or just download via fetch to avoid page navigation conflicts
    // Since Puppeteer handles download behavior on the page level, we need to click. 
    // Ideally, we fetch the PDF URL directly if possible, but GeM uses a redirector.
    // For parallelism with click-to-download, we need separate pages or sequential clicks.
    // OPTIMIZATION: We will fetch the href directly using Node's fetch, bypassing the browser render for the PDF.
    
    try {
        const tempFileName = `bid_${bidNo.replace(/\//g, '_')}_${Date.now()}.pdf`;
        const tempFilePath = path.join(DOWNLOAD_DIR, tempFileName);

        // GeM links usually redirect. Fetch handles redirects.
        const dlSuccess = await downloadFile(href, tempFilePath);

        if (dlSuccess) {
            const result = await processPdfFile(tempFilePath);
            let allEmails = [...result.extracted.emails];
            let finalIsInspection = result.isInspection;
            let finalSummary = result.summarySnippet;

            // Process linked PDFs
            if (result.extracted.pdfLinks.length > 0) {
                for (const pdfUrl of result.extracted.pdfLinks) {
                    const linkedTemp = path.join(DOWNLOAD_DIR, `linked_${Date.now()}.pdf`);
                    if (await downloadFile(pdfUrl, linkedTemp)) {
                        const linkedExtraction = await extractEmailsFromBuffer(fs.readFileSync(linkedTemp));
                        allEmails.push(...linkedExtraction.emails);
                        const linkedAnalysis = analyzeTextForInspection(linkedExtraction.rawText);
                        if (linkedAnalysis.isInspection) {
                            finalIsInspection = true;
                            finalSummary += ` | (Linked): ${linkedAnalysis.summarySnippet}`;
                        }
                        fs.unlinkSync(linkedTemp);
                    }
                }
            }

            allEmails = [...new Set(allEmails)];
            if (allEmails.length > 0) updateEmailDatabase(allEmails);

            const dbEntry = {
                timestamp: Date.now(),
                bidNumber: bidNo,
                originalFileName: tempFileName,
                status: "complete",
                extractedData: { pdfLinks: result.extracted.pdfLinks, allEmails: allEmails },
                inspectionAnalysis: { isRelated: finalIsInspection, summary: finalSummary }
            };
            
            fs.unlinkSync(tempFilePath); // Clean up
            return { href, dbEntry };
        }
    } catch (e) {
        console.error(`Error processing ${bidNo}: ${e.message}`);
    }
    return null;
}

// --- MAIN EXECUTION ---
(async () => {
    console.log('--- Starting Automated Scraper (Optimized) ---');
    let urlDb = pruneDatabase(loadDatabase());
    
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized']
    });
    const page = await browser.newPage();
    
    // 1. OPTIMIZATION: Block resources
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    await page.setViewport({ width: 1366, height: 768 });

    try {
        console.log('Navigating to GeM...');
        await page.goto('https://bidplus.gem.gov.in/advance-search', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Select Ministry
        await page.waitForSelector('#ministry-tab');
        await page.click('#ministry-tab');
        
        // Wait for dropdown population
        await page.waitForFunction(() => {
            const select = document.querySelector('#ministry');
            return select && select.options.length > 1;
        });

        await page.evaluate((target) => {
            const select = document.querySelector('#ministry');
            const opt = Array.from(select.options).find(o => o.text.includes(target));
            if (opt) {
                select.value = opt.value;
                select.dispatchEvent(new Event('change')); 
            }
        }, CONFIG.ministryString);

        await new Promise(r => setTimeout(r, 2000)); 
        await page.click('#tab1 #searchByBid');

        let hasNextPage = true;
        let pageNum = 1;
        let previousPageBidIds = []; // 2. FIX: Infinite loop detector

        while (hasNextPage) {
            console.log(`\n=== Processing Page ${pageNum} ===`);
            
            // Wait for loader to disappear (GeM specific)
            try {
                await page.waitForSelector('.backgroundLoder', { hidden: true, timeout: 30000 });
                await page.waitForSelector('#bidCard .card', { visible: true, timeout: 60000 });
            } catch (e) {
                console.log("No bids found or timeout.");
                break;
            }

            // Extract all links and Bid IDs from current page
            const currentBids = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('#bidCard a[href*="showbidDocument"]'));
                return links.map(el => ({
                    href: el.href,
                    bidNo: el.innerText.trim()
                }));
            });

            // 2. FIX: Logic to stop if page content hasn't changed
            const currentBidIds = currentBids.map(b => b.bidNo).sort().join(',');
            const prevBidIdsStr = previousPageBidIds.sort().join(',');

            if (currentBids.length === 0) {
                console.log("No bids found on this page. Stopping.");
                break;
            }

            if (currentBidIds === prevBidIdsStr) {
                console.log("!! Detected duplicate page content (Pagination stuck). Stopping script. !!");
                hasNextPage = false;
                break;
            }
            previousPageBidIds = currentBids.map(b => b.bidNo);

            // 3. OPTIMIZATION: Process in Batches/Parallel
            const BATCH_SIZE = 5;
            for (let i = 0; i < currentBids.length; i += BATCH_SIZE) {
                const batch = currentBids.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(batch.map(bid => processSingleBid(bid, page, urlDb)));
                
                // Save results back to DB
                let savedCount = 0;
                results.forEach(res => {
                    if (res) {
                        urlDb[res.href] = res.dbEntry;
                        savedCount++;
                    }
                });
                if (savedCount > 0) saveDatabase(urlDb);
            }

            // Check Next Button
            // GeM pagination: <a href="..." class="page-link next">Next</a>
            // If disabled, it might have class 'disabled' on the LI or the A tag, or simply not exist.
            const nextBtn = await page.$('#light-pagination .next');
            const isNextDisabled = nextBtn ? await page.evaluate(el => 
                el.classList.contains('disabled') || el.parentElement.classList.contains('disabled'), nextBtn) : true;

            if (nextBtn && !isNextDisabled) {
                await nextBtn.click();
                // Wait for the AJAX loader to appear and then disappear to ensure content loaded
                try {
                    await page.waitForSelector('.backgroundLoder', { visible: true, timeout: 5000 });
                    await page.waitForSelector('.backgroundLoder', { hidden: true, timeout: 30000 });
                } catch(e) {
                    // Sometimes loader is too fast, just wait a bit
                    await new Promise(r => setTimeout(r, 2000));
                }
                pageNum++;
            } else {
                console.log("End of pagination reached.");
                hasNextPage = false;
            }
        }
    } catch (err) { console.error("Runtime Error:", err); }
    finally { await browser.close(); }
})();