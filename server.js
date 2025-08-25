import express from "express";
import 'dotenv/config';
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Function to extract meaningful content from HTML
function extractMainContent(html, url) {
  const $ = cheerio.load(html);
  
  // Remove unwanted elements
  $('script, style, nav, header, footer, .sidebar, .advertisement, .ads, .social-share').remove();
  
  let mainContent = '';
  
  // Try to find main content areas
  const contentSelectors = [
    'article',
    'main',
    '[role="main"]',
    '.content',
    '.post-content',
    '.article-content',
    '.entry-content',
    '#content',
    '.main-content'
  ];
  
  for (const selector of contentSelectors) {
    const element = $(selector).first();
    if (element.length && element.text().trim().length > 500) {
      mainContent = element.text().trim();
      break;
    }
  }
  
  // If no main content found, try to extract from common elements
  if (!mainContent) {
    const paragraphs = $('p').map((i, el) => $(el).text().trim()).get().join(' ');
    const headings = $('h1, h2, h3, h4, h5, h6').map((i, el) => $(el).text().trim()).get().join(' ');
    mainContent = `${headings} ${paragraphs}`.trim();
  }
  
  // If still no content, get all text content
  if (!mainContent) {
    mainContent = $('body').text().trim();
  }
  
  // Clean up the text
  mainContent = mainContent
    .replace(/\s+/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();
  
  // Limit content length for API efficiency
  if (mainContent.length > 10000) {
    mainContent = mainContent.substring(0, 10000) + '...';
  }
  
  return mainContent;
}

// Function to get page metadata
function extractMetadata(html) {
  const $ = cheerio.load(html);
  
  return {
    title: $('title').text() || $('h1').first().text() || 'No title found',
    description: $('meta[name="description"]').attr('content') || 
                $('meta[property="og:description"]').attr('content') || 
                'No description found',
    keywords: $('meta[name="keywords"]').attr('content') || 'No keywords found'
  };
}

// Endpoint to analyze URL
app.post("/analyze", async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }

    console.log(`Analyzing URL: ${url}`);

    // Fetch website content with proper headers
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Cache-Control': 'max-age=0',
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const html = await response.text();
    
    // Extract main content and metadata
    const mainContent = extractMainContent(html, url);
    const metadata = extractMetadata(html);
    
    if (!mainContent || mainContent.length < 100) {
      return res.status(400).json({ error: "Unable to extract meaningful content from the URL" });
    }

    console.log(`Extracted ${mainContent.length} characters of content`);

    // Prepare comprehensive prompt for Gemini
    const analysisPrompt = `
Please analyze the following web content comprehensively. The content is from: ${url}

Page Title: ${metadata.title}
Page Description: ${metadata.description}

Content to analyze:
${mainContent}

Please provide a detailed analysis in the following JSON format:

{
  "themes": [
    "List the main themes and topics discussed in the content"
  ],
  "sentiment": {
    "overall": "positive/negative/neutral",
    "tone": "describe the overall tone (e.g., professional, casual, academic, persuasive, etc.)",
    "confidence": "high/medium/low"
  },
  "summary": "Provide a comprehensive summary of the content (3-4 paragraphs, written naturally as humans would write, capturing all important points and nuances)",
  "keyInsights": [
    "List 5-7 key insights, findings, or important points from the content",
    "Each insight should be detailed and meaningful",
    "Include specific details and context where relevant"
  ],
  "intentions": [
    "What appears to be the author's main intentions or purposes"
  ],
  "targetAudience": "Who seems to be the intended audience for this content",
  "contentType": "What type of content this is (article, blog post, news, academic paper, etc.)",
  "expertise": "What level of expertise or authority does the content demonstrate",
  "actionablePoints": [
    "Any actionable advice, recommendations, or takeaways for readers"
  ]
}

Make sure your analysis is thorough, accurate, and provides genuine value. The summary should be well-written and comprehensive, not just a brief overview.`;

    // Call Gemini API for analysis
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(analysisPrompt);
    const response_text = result.response.text();
    
    console.log("Gemini API response received");
    
    // Parse the JSON response
    let analysis;
    try {
      // Clean the response to extract JSON
      const jsonMatch = response_text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("No valid JSON found in response");
      }
    } catch (parseError) {
      console.error("Error parsing JSON:", parseError);
      console.log("Raw response:", response_text);
      
      // Fallback: provide a basic analysis structure
      analysis = {
        themes: ["Content Analysis"],
        sentiment: {
          overall: "neutral",
          tone: "informative",
          confidence: "medium"
        },
        summary: response_text.substring(0, 500) + "...",
        keyInsights: ["Analysis completed successfully"],
        intentions: ["Information sharing"],
        targetAudience: "General audience",
        contentType: "Web content",
        expertise: "Standard",
        actionablePoints: ["Review the analyzed content"]
      };
    }

    // Add metadata to the response
    analysis.metadata = {
      url: url,
      title: metadata.title,
      description: metadata.description,
      contentLength: mainContent.length,
      analyzedAt: new Date().toISOString()
    };

    res.json({ success: true, analysis });

  } catch (error) {
    console.error("Analysis error:", error);
    res.status(500).json({ 
      error: "Failed to analyze URL", 
      details: error.message 
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "Server is running", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Make sure to set GEMINI_API_KEY in your environment variables");
});