// Adapt legacy mock picks to the compact selection contract. No production matching logic here.
module.exports = function rankingFixture(reply, messages) {
  if (!reply || typeof reply !== 'object' || 'cravingFit' in reply || !('merchantId' in reply)) return reply;
  const prompt = messages.map(m => m.content).join('\n');
  const craving = !/- Specific craving: (none|anything|surprise me)\n/i.test(prompt);
  const mood = !/- Food mood today: Anything\n/.test(prompt);
  const fit = reply.relevance || reply.confidence || 'high';
  return { merchantId: reply.merchantId, cravingFit: craving ? fit : 'not_applicable',
    moodFit: mood ? fit : 'not_applicable', overallFit: fit, reason: reply.reason };
};
