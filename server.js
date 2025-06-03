const express = require('express');
const { chromium, firefox, webkit } = require('playwright');
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
async function processChunk(chunk, retries = 3, browserType = 'chromium') {
  let browser;
  
  try {
    // Try different browsers if one fails
    const browsers = [chromium, firefox, webkit];
    const currentBrowser = browserType === 'firefox' ? firefox : 
                          browserType === 'webkit' ? webkit : chromium;
    
    browser = await currentBrowser.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ]
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      viewport: { width: 1280, height: 720 }
    });
    
    const page = await context.newPage();
    
    // Set longer timeout
    page.setDefaultTimeout(60000);
    
    // Navigate to the site with error handling
    await page.goto('https://aihumanize.io/', { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    
    // Wait a bit to appear more human-like
    await page.waitForTimeout(Math.random() * 3000 + 2000);
    
    // Try multiple selectors for the input field
    const inputSelectors = [
      'textarea',
      'input[type="text"]',
      '[placeholder*="text"]',
      '[placeholder*="paste"]',
      '#input',
      '.input',
      'textarea:first-of-type'
    ];
    
    let inputFound = false;
    for (const selector of inputSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        await page.click(selector);
        await page.fill(selector, chunk);
        inputFound = true;
        console.log(`Input found with selector: ${selector}`);
        break;
      } catch (e) {
        continue;
      }
    }
    
    if (!inputFound) {
      throw new Error('Could not find input field on the website');
    }
    
    // Wait before clicking submit
    await page.waitForTimeout(1000);
    
    // Try multiple selectors for the submit button
    const buttonSelectors = [
      'button:has-text("Humanize")',
      'button:has-text("humanize")',
      'button[type="submit"]',
      'input[type="submit"]',
      '.submit-btn',
      '.humanize-btn',
      'button:first-of-type'
    ];
    
    let buttonFound = false;
    for (const selector of buttonSelectors) {
      try {
        await page.click(selector, { timeout: 5000 });
        buttonFound = true;
        console.log(`Button found with selector: ${selector}`);
        break;
      } catch (e) {
        continue;
      }
    }
    
    if (!buttonFound) {
      throw new Error('Could not find submit button on the website');
    }
    
    // Wait for processing and results
    await page.waitForTimeout(5000);
    
    // Try to find result with multiple approaches
    const resultSelectors = [
      'textarea:last-of-type',
      '.result',
      '.output', 
      '[class*="result"]',
      '[class*="output"]',
      'div[class*="text"]:last-child',
      '#output'
    ];
    
    let result = '';
    for (const selector of resultSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 15000 });
        const element = await page.$(selector);
        if (element) {
          result = await element.textContent();
          if (result && result.trim() && result.trim() !== chunk.trim()) {
            console.log(`Result found with selector: ${selector}`);
            break;
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    await browser.close();
    
    // Return processed result or original if no valid result found
    return result && result.trim() ? result.trim() : chunk;
    
  } catch (error) {
    console.error(`Error processing chunk with ${browserType}:`, error.message);
    
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Error closing browser:', closeError);
      }
    }
    
    if (retries > 0) {
      console.log(`Retrying with different browser... ${retries} attempts left`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Try different browser on retry
      const nextBrowser = browserType === 'chromium' ? 'firefox' : 
                         browserType === 'firefox' ? 'webkit' : 'chromium';
      
      return processChunk(chunk, retries - 1, nextBrowser);
    }
    
    // Return original text with error info if all retries failed
    throw new Error(`Failed to process chunk after all retries: ${error.message}`);
  }
}

// Main API endpoint
app.post('/process-text', async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ 
        error: 'No text provided',
        type: 'validation_error'
      });
    }
    
    if (text.length > 15000) {
      return res.status(400).json({ 
        error: 'Text is too long. Please limit to 15,000 characters.',
        type: 'validation_error'
      });
    }
    
    // Split text into chunks
    const chunks = splitTextIntoChunks(text.trim());
    console.log(`Processing ${chunks.length} chunks`);
    
    // Process each chunk
    const processedChunks = [];
    const errors = [];
    
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Processing chunk ${i + 1}/${chunks.length}`);
      
      try {
        const processed = await processChunk(chunks[i]);
        processedChunks.push(processed);
        
        // Add delay between requests to avoid rate limiting
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 4000));
        }
        
      } catch (error) {
        console.error(`Failed to process chunk ${i + 1}:`, error.message);
        errors.push(`Chunk ${i + 1}: ${error.message}`);
        processedChunks.push(chunks[i]); // Use original if processing fails
      }
    }
    
    // Combine all processed chunks
    const finalResult = processedChunks.join(' ');
    
    // Determine response based on errors
    if (errors.length === chunks.length) {
      // All chunks failed
      return res.status(500).json({
        error: 'Failed to process any chunks. The website may be down or blocking requests.',
        type: 'processing_error',
        details: errors.slice(0, 3), // Limit error details
        result: text // Return original text
      });
    } else if (errors.length > 0) {
      // Some chunks failed
      return res.json({
        success: true,
        warning: `${errors.length} out of ${chunks.length} chunks failed to process`,
        originalLength: text.length,
        processedLength: finalResult.length,
        chunksProcessed: chunks.length,
        chunksSuccessful: chunks.length - errors.length,
        errors: errors.slice(0, 3), // Limit error details
        result: finalResult
      });
    } else {
      // All successful
      return res.json({ 
        success: true, 
        originalLength: text.length,
        processedLength: finalResult.length,
        chunksProcessed: chunks.length,
        chunksSuccessful: chunks.length,
        result: finalResult 
      });
    }
    
  } catch (error) {
    console.error('Error in /process-text:', error);
    res.status(500).json({ 
      error: 'Internal server error occurred',
      type: 'server_error',
      message: error.message 
    });
  }
});
    
    
