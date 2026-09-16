console.log('NETS Vouch AI Express prototype loaded');

const transactionAnalysisCheckbox = document.getElementById('transactionAnalysis');
const modeNote = document.getElementById('modeNote');
const modeTitle = document.getElementById('modeTitle');
const modeDescription = document.getElementById('modeDescription');

function updateModeMessage() {
  if (transactionAnalysisCheckbox.checked) {
    modeNote.className = 'mode-note mode-note--personalised';
    modeTitle.textContent = 'Personalised Mode';
    modeDescription.textContent = 'Optional NETS activity patterns are enabled together with the preferences you choose.';
  } else {
    modeNote.className = 'mode-note mode-note--basic';
    modeTitle.textContent = 'Basic Mode';
    modeDescription.textContent = 'Recommendations can use your selected preferences, location and time. No transaction history is required.';
  }
}

if (transactionAnalysisCheckbox && modeNote && modeTitle && modeDescription) {
  transactionAnalysisCheckbox.addEventListener('change', updateModeMessage);
}
