/**
 * Google Apps Script: Forward Job Alert Emails to Mastra
 * 
 * SETUP INSTRUCTIONS:
 * 1. Go to https://script.google.com
 * 2. Create a new project
 * 3. Paste this entire script
 * 4. Replace MASTRA_URL below with your deployed app URL
 * 5. Click Run > forwardJobAlerts
 * 6. Authorize the script when prompted
 * 7. (Optional) Set up a time-based trigger to run automatically:
 *    - Click Triggers (clock icon) > Add Trigger
 *    - Function: forwardJobAlerts
 *    - Time-based trigger > Day timer > 6am-7am
 */

const MASTRA_URL = "https://YOUR-APP-URL.replit.app/api/import-emails";

const API_KEY = "YOUR-IMPORT-API-KEY";

const LABEL_NAME = "Job Alerts";

function forwardJobAlerts() {
  const label = GmailApp.getUserLabelByName(LABEL_NAME);
  if (!label) {
    Logger.log("Label '" + LABEL_NAME + "' not found. Available labels:");
    GmailApp.getUserLabels().forEach(function(l) {
      Logger.log("  - " + l.getName());
    });
    return;
  }
  
  const threads = label.getThreads(0, 20);
  Logger.log("Found " + threads.length + " threads in '" + LABEL_NAME + "'");
  
  const emails = [];
  
  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    if (!thread.isUnread()) continue;
    
    var messages = thread.getMessages();
    for (var j = 0; j < messages.length; j++) {
      var msg = messages[j];
      emails.push({
        subject: msg.getSubject(),
        from: msg.getFrom(),
        date: msg.getDate().toISOString(),
        body: msg.getPlainBody() || msg.getBody().replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
      });
    }
    
    thread.markRead();
  }
  
  if (emails.length === 0) {
    Logger.log("No unread job alert emails found");
    return;
  }
  
  Logger.log("Sending " + emails.length + " emails to Mastra");
  
  var response = UrlFetchApp.fetch(MASTRA_URL, {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": API_KEY },
    payload: JSON.stringify(emails),
    muteHttpExceptions: true
  });
  
  Logger.log("Response: " + response.getContentText());
}
