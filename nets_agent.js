const { generateText, tool } = require('ai');
const { createGroq } = require('@ai-sdk/groq');
const { z } = require('zod');
// FIXED: Point to the Database folder where db.js is located
const db = require('./Database/db');

const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });

async function getAgentRecommendations(userPrompt, userId) {
    try {
        const [userRows] = await db.query('SELECT * FROM users WHERE user_id = ?', [userId]);
        const userProfile = userRows[0];

        if (!userProfile) {
            console.error("User not found in DB, falling back to defaults.");
            throw new Error("Database user missing");
        }

        const { toolCalls } = await generateText({
            model: groq('llama3-8b-8192'),
            system: `You are the NETS Vouch AI Concierge.
                     Your ONLY job is to extract search parameters from the user's prompt and use the search_database tool.
                     - Max Budget constraint is $${userProfile.budget_max}.
                     - Dietary restriction is ${userProfile.dietary_preference}.
                     DO NOT invent merchants. Return the tool results.`,
            prompt: userPrompt || "Find me something to eat.",
            tools: {
                search_database: tool({
                    description: 'Search the NETS MySQL database for participating merchants.',
                    parameters: z.object({
                        requestedPrice: z.number().optional().describe('Maximum meal price based on user request'),
                        dietary: z.enum(['none', 'halal', 'vegetarian', 'vegan']).describe('Dietary need')
                    }),
                    execute: async ({ requestedPrice, dietary }) => {
                        console.log(`🤖 Agent executing SQL Tool -> Diet: ${dietary}, Price: ${requestedPrice}`);
                        
                        const baseBudget = requestedPrice || userProfile.budget_max;
                        const workingBudget = baseBudget / userProfile.weight_price_sensitivity;

                        let sql = `SELECT * FROM merchants WHERE typical_price <= ?`;
                        let params = [workingBudget];

                        if (dietary !== 'none') {
                            sql += ` AND dietary_${dietary} = TRUE`;
                        }
                        
                        sql += ` ORDER BY distance_metres ASC, typical_price ASC LIMIT 3`;
                        const [merchants] = await db.query(sql, params);
                        
                        return merchants.map(m => ({
                            id: m.merchant_id,
                            merchantName: m.name,
                            distanceMetres: m.distance_metres,
                            price: m.typical_price,
                            categoryLabel: m.cuisine_type,
                            rewardAmount: m.reward_amount,
                            minSpend: m.min_spend,
                            busyness: '🟢 Usually quieter at this time'
                        }));
                    }
                })
            },
            maxSteps: 2
        });

        if (toolCalls && toolCalls.length > 0 && toolCalls[0].toolName === 'search_database') {
            return toolCalls[0].result;
        }
        return [];
    } catch (error) {
        console.error("Agent Error:", error);
        return [];
    }
}

module.exports = { getAgentRecommendations };