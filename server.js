const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Function to split text into chunks
function splitTextIntoChunks(text, maxWords = 200) {
  const words = text.split(' ');
  const chunks = [];
  
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords).join(' '));
  }
  
  return chunks;
}

// Function to process a single chunk through aihumanize.io
async function processChunk(chunk, retries = 3) {
  let browser;
  
  try {
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
    
    // Set user agent to appear more human-like
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    // Navigate to the site
    await page.goto('https://aihumanize.io/', { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });
    
    // Wait a bit to appear more human-like
    await page.waitForTimeout(2000);
    
    // Find and fill the input textarea
    await page.waitForSelector('textarea', { timeout: 10000 });
    await page.click('textarea');
    await page.keyboard.type(chunk, { delay: 50 });
    
    // Click the humanize button
    await page.waitForSelector('button:contains("Humanize")', { timeout: 5000 });
    await page.click('button:contains("Humanize")');
    
    // Wait for results
    await page.waitForSelector('.result, .output, [class*="result"], [class*="output"]', { 
      timeout: 30000 
    });
    
    // Extract the result text
    const result = await page.evaluate(() => {
      // Try multiple selectors to find the output
      const selectors = [
        '.result',
        '.output', 
        '[class*="result"]',
        '[class*="output"]',
        'textarea:last-of-type',
        'div[class*="text"]:last-child'
      ];
      
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent.trim()) {
          return element.textContent.trim();
        }
      }
      return '';
    });
    
    await browser.close();
    return result || chunk; // Return original if no result found
    
  } catch (error) {
    console.error('Error processing chunk:', error);
    if (browser) await browser.close();
    
    if (retries > 0) {
      console.log(`Retrying... ${retries} attempts left`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      return processChunk(chunk, retries - 1);
    }
    
    return chunk; // Return original text if all retries failed
  }
}

// Main API endpoint
app.post('/process-text', async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'No text provided' });
    }
    
    // Split text into chunks
    const chunks = splitTextIntoChunks(text.trim());
    console.log(`Processing ${chunks.length} chunks`);
    
    // Process each chunk
    const processedChunks = [];
    
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Processing chunk ${i + 1}/${chunks.length}`);
      
      try {
        const processed = await processChunk(chunks[i]);
        processedChunks.push(processed);
        
        // Add delay between requests to avoid rate limiting
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      } catch (error) {
        console.error(`Failed to process chunk ${i + 1}:`, error);
        processedChunks.push(chunks[i]); // Use original if processing fails
      }
    }
    
    