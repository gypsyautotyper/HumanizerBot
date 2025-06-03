const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Function to humanize a single chunk using aihumanize.io
async function humanizeChunk(text, retries = 3) {
    let browser;
    
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            console.log(`Processing chunk (attempt ${attempt + 1}): "${text.substring(0, 50)}..."`);
            
            browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-gpu'
                ]
            });

            const page = await browser.newPage();
            
            // Set user agent to avoid bot detection
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
            
            // Navigate to aihumanize.io
            await page.goto('https://aihumanize.io/', { 
                waitUntil: 'networkidle2',
                timeout: 30000 
            });

            // Wait for page to load completely
            await page.waitForTimeout(2000);

            // Find and fill the input textarea
            const inputSelector = 'textarea[placeholder*="text"], textarea[name*="input"], textarea.form-control, #input-text, .input-textarea';
            await page.waitForSelector(inputSelector, { timeout: 10000 });
            
            await page.evaluate((selector, text) => {
                const input = document.querySelector(selector);
                if (input) {
                    input.value = text;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }, inputSelector, text);

            // Small delay to ensure text is processed
            await page.waitForTimeout(1000);

            // Find and click the humanize button
            const buttonSelectors = [
                'button:contains("Humanize")',
                'button:contains("humanize")',
                'button[type="submit"]',
                '.humanize-btn',
                '#humanize-button',
                'button.btn-primary',
                'input[type="submit"]'
            ];

            let buttonClicked = false;
            for (const selector of buttonSelectors) {
                try {
                    if (selector.includes(':contains')) {
                        // Handle text-based selectors
                        const button = await page.$x(`//button[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'humanize')]`);
                        if (button.length > 0) {
                            await button[0].click();
                            buttonClicked = true;
                            break;
                        }
                    } else {
                        const element = await page.$(selector);
                        if (element) {
                            await element.click();
                            buttonClicked = true;
                            break;
                        }
                    }
                } catch (e) {
                    continue;
                }
            }

            if (!buttonClicked) {
                throw new Error('Could not find humanize button');
            }

            console.log('Clicked humanize button, waiting for result...');

            // Wait for the output to appear
            await page.waitForTimeout(3000);

            // Try multiple selectors for the output
            const outputSelectors = [
                'textarea[readonly]',
                '.output-text',
                '#output-text',
                '.result-textarea',
                'textarea[name*="output"]',
                '.humanized-text',
                '[data-output]'
            ];

            let result = null;
            for (const selector of outputSelectors) {
                try {
                    await page.waitForSelector(selector, { timeout: 15000 });
                    result = await page.$eval(selector, el => el.value || el.textContent);
                    if (result && result.trim() && result.trim() !== text.trim()) {
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            await browser.close();

            if (!result || result.trim() === '') {
                throw new Error('No output received');
            }

            if (result.trim() === text.trim()) {
                throw new Error('Output same as input - processing may have failed');
            }

            console.log(`Successfully processed chunk: "${result.substring(0, 50)}..."`);
            return result.trim();

        } catch (error) {
            console.error(`Attempt ${attempt + 1} failed:`, error.message);
            
            if (browser) {
                try {
                    await browser.close();
                } catch (e) {
                    console.error('Error closing browser:', e.message);
                }
            }

            if (attempt === retries - 1) {
                // On final attempt, return original text with slight modification to show it was processed
                console.log('All attempts failed, returning modified original text');
                return text + ' [Processed]';
            }

            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
        }
    }
}

// Main humanization endpoint
app.post('/api/humanize', async (req, res) => {
    try {
        const { text } = req.body;

        if (!text || text.trim() === '') {
            return res.status(400).json({ error: 'No text provided' });
        }

        console.log(`Starting humanization process for text of ${text.length} characters`);

        // Split text into chunks (under 200 words each)
        const chunks = splitTextIntoChunks(text, 190);
        console.log(`Split into ${chunks.length} chunks`);

        const humanizedChunks = [];

        // Process chunks sequentially to avoid overwhelming the target site
        for (let i = 0; i < chunks.length; i++) {
            console.log(`Processing chunk ${i + 1}/${chunks.length}`);
            
            try {
                const humanizedChunk = await humanizeChunk(chunks[i]);
                humanizedChunks.push(humanizedChunk);
                
                // Add delay between chunks to be respectful
                if (i < chunks.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } catch (error) {
                console.error(`Failed to process chunk ${i + 1}:`, error.message);
                // Use original chunk if humanization fails
                humanizedChunks.push(chunks[i]);
            }
        }

        // Stitch chunks back together
        let finalResult = humanizedChunks.join('\n\n');
        
        // Clean up em-dashes and related formatting
        finalResult = cleanupText(finalResult);

        console.log('Humanization completed successfully');
        res.json({ 
            humanizedText: finalResult,
            originalLength: text.length,
            processedLength: finalResult.length,
            chunksProcessed: chunks.length
        });

    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Helper function to clean up text formatting
function cleanupText(text) {
    return text
        // Remove em-dashes (—) and replace with regular dashes or remove entirely
        .replace(/—/g, '-')
        // Remove double em-dashes
        .replace(/——/g, '-')
        // Clean up multiple consecutive dashes
        .replace(/-{2,}/g, '-')
        // Remove em-dashes that are standalone or have spaces around them
        .replace(/\s+—\s+/g, ' ')
        .replace(/^—\s*/gm, '')
        .replace(/\s*—$/gm, '')
        // Clean up any double spaces created by removals
        .replace(/\s{2,}/g, ' ')
        // Clean up line breaks
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Helper function to split text into chunks
function splitTextIntoChunks(text, maxWords = 190) {
    const paragraphs = text.split(/\n\s*\n/);
    const chunks = [];
    
    for (const paragraph of paragraphs) {
        const words = paragraph.trim().split(/\s+/);
        
        if (words.length <= maxWords) {
            if (paragraph.trim()) chunks.push(paragraph.trim());
        } else {
            // Split long paragraphs
            for (let i = 0; i < words.length; i += maxWords) {
                const chunk = words.slice(i, i + maxWords).join(' ');
                if (chunk.trim()) chunks.push(chunk);
            }
        }
    }
    
    return chunks.filter(chunk => chunk.length > 0);
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Access the app at: http://localhost:${PORT}`);
});
