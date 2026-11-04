// Spreadsheet reader for the Marketing Dashboard (read-only).
//
// Deploy from a team Google account that can already view the spreadsheets:
//   Deploy > New deployment > Web app, "Execute as: Me", "Who has access: Anyone".
// Script properties (Project Settings > Script properties), never in code:
//   READER_KEY        the same value as the dashboard's SHEET_READER_KEY (at least 32 characters)
//   ALLOWED_FILE_IDS  comma-separated Drive file ids this script may return; anything else is refused
// The script only reads. It never edits files and never changes sharing.

var XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var props = PropertiesService.getScriptProperties();
    var key = props.getProperty('READER_KEY') || '';
    if (key.length < 32 || !sameText_(String(body.key || ''), key)) return reply_({ ok: false, error: 'bad_key' });

    var id = String(body.fileId || '');
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(id) || (body.kind !== 'google_sheet' && body.kind !== 'xlsx')) {
      return reply_({ ok: false, error: 'bad_request' });
    }
    var allowed = (props.getProperty('ALLOWED_FILE_IDS') || '').split(',').map(function (s) { return s.trim(); });
    if (allowed.indexOf(id) < 0) return reply_({ ok: false, error: 'not_allowed' });

    var url = body.kind === 'google_sheet'
      ? 'https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=' + encodeURIComponent(XLSX)
      : 'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media&supportsAllDrives=true';
    var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    var code = res.getResponseCode();
    if (code === 403 || code === 404) return reply_({ ok: false, error: 'no_access' });
    if (code !== 200) return reply_({ ok: false, error: 'read_failed' });
    return reply_({ ok: true, data: Utilities.base64Encode(res.getBlob().getBytes()) });
  } catch (err) {
    return reply_({ ok: false, error: 'read_failed' });
  }
}

function doGet() {
  return reply_({ ok: false, error: 'bad_request' });
}

// Compares without stopping at the first different character.
function sameText_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Run once from the editor to approve Drive read access and check that every allowed file opens.
function checkAccess() {
  var ids = (PropertiesService.getScriptProperties().getProperty('ALLOWED_FILE_IDS') || '').split(',');
  ids.forEach(function (raw) {
    var id = raw.trim();
    if (!id) return;
    var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '?fields=name,mimeType&supportsAllDrives=true',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    Logger.log(id.slice(0, 6) + '...: ' + (res.getResponseCode() === 200 ? 'OK ' + JSON.parse(res.getContentText()).name : 'NO ACCESS (' + res.getResponseCode() + ')'));
  });
}
