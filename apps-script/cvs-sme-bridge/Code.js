const BRIDGE = {
  HEADER_ROW: 1,
  DATA_START_ROW: 2,
  TIMEZONE: 'Asia/Bangkok',
  NONCE_TTL_SEC: 300,
  IDEMPOTENCY_TTL_SEC: 86400,
  IDEMPOTENCY_GC_INTERVAL_SEC: 3600,
  CACHE_TTL_SEC: 300,
  CACHE_CHUNK_CHARS: 25000,
  FIELD_SYNC_SHEET: '__SYNC_FIELD_TIMES',
  FIELD_SYNC_HEADERS: ['teamId','storeId','field','version','changedAt'],
  REPORT_CONFIG_SHEET: '__REPORT_CONFIG',
  REPORT_CONFIG_HEADERS: ['account','kind','id','sort','active','data','updatedAt'],
};

function doGet() {
  const p = PropertiesService.getScriptProperties();
  return json_({
    ok: true,
    service: 'cvs-sme-bridge',
    configured: !!(p.getProperty('SPREADSHEET_ID') && p.getProperty('BRIDGE_SECRET')),
  });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    verifyEnvelope_(body);
    const action = str_(body.action);
    const params = body.params || {};
    const requestId = str_(body.requestId);

    if (isMutation_(action)) {
      if (!requestId || requestId.length > 128) throw new Error('Missing or invalid requestId');
      return json_(runMutation_(action, params, requestId));
    }
    return json_(dispatch_(action, params, requestId));
  } catch (err) {
    return json_({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

function authorizeDevStaging() {
  // Run once in the Apps Script editor to grant spreadsheet and property scopes.
  const info = getSheets_();
  return {ok:info.ok, sheetCount:info.sheets.length};
}

function setupDevConfig(spreadsheetId, bridgeSecret) {
  if (!spreadsheetId || !bridgeSecret) throw new Error('spreadsheetId and bridgeSecret are required');
  PropertiesService.getScriptProperties().setProperties({
    SPREADSHEET_ID: String(spreadsheetId),
    BRIDGE_SECRET: String(bridgeSecret),
  }, false);
  return { ok: true };
}

function rotateBridgeSecret(bridgeSecret) {
  if (!bridgeSecret) throw new Error('bridgeSecret is required');
  PropertiesService.getScriptProperties().setProperty('BRIDGE_SECRET', String(bridgeSecret));
  return { ok: true };
}

function verifyEnvelope_(body) {
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty('BRIDGE_SECRET');
  if (!secret) throw new Error('Bridge is not configured');

  const ts = Number(body.ts || 0);
  const nonce = str_(body.nonce);
  const signature = str_(body.signature);
  if (!ts || !nonce || !signature) throw new Error('Missing bridge authentication');
  if (Math.abs(Date.now() - ts) > BRIDGE.NONCE_TTL_SEC * 1000) throw new Error('Expired bridge request');

  const nonceKey = 'nonce_' + digestKey_(nonce);
  const cache = CacheService.getScriptCache();
  if (cache.get(nonceKey)) throw new Error('Replay rejected');

  const canonical = canonicalEnvelope_(body);
  const bytes = Utilities.computeHmacSha256Signature(canonical, secret, Utilities.Charset.UTF_8);
  const expected = Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
  if (!constantTimeEqual_(expected, signature)) throw new Error('Invalid bridge signature');

  cache.put(nonceKey, '1', BRIDGE.NONCE_TTL_SEC);
}

function canonicalEnvelope_(body) {
  return JSON.stringify({
    method: 'POST',
    path: '/bridge',
    action: str_(body.action),
    params: body.params || {},
    requestId: str_(body.requestId),
    ts: Number(body.ts || 0),
    nonce: str_(body.nonce),
  });
}

function constantTimeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i % Math.max(1,a.length)) || 0) ^ (b.charCodeAt(i % Math.max(1,b.length)) || 0);
  return diff === 0;
}

function dispatch_(action, p, requestId) {
  switch (action) {
    case 'health': return { ok: true, service: 'bridge', now: new Date().toISOString() };
    case 'getSheets': return getSheets_();
    case 'getPlaces': return getPlaces_(p.sheet);
    case 'markVisited': return markVisited_(p.sheet, p.id, p.baseVersion);
    case 'resetVisitedAll': return resetVisitedAll_(p.sheet);
    case 'saveNoted': return saveNoted_(p.sheet, p.id, p.noted, p.baseVersion);
    case 'updateRoute': return updateRoute_(p.sheet, p.id, p.route, p.baseVersion);
    case 'updateLocation': return updateLocation_(p.sheet, p.id, p.lat, p.lng, p.baseVersion);
    case 'getReportConfig': return getReportConfig_(p.account);
    case 'getReportConfigMeta': return getReportConfigMeta_(p.account);
    case 'getFreshSheetSnapshot': return buildFreshSheetSnapshot_();
    case 'saveReportConfigBulk': return saveReportConfigBulk_(p.items || [], requestId, p.baseVersion);
    default: throw new Error('Unknown action: ' + action);
  }
}

function isMutation_(action) {
  return ['markVisited','resetVisitedAll','saveNoted','updateRoute','updateLocation',
    'saveReportConfigBulk'].indexOf(action) !== -1;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, error: 'LOCK_TIMEOUT' };
  try { return fn(); } finally { lock.releaseLock(); }
}

// Standalone Apps Script projects require an installable spreadsheet edit
// trigger; the simple onEdit trigger does NOT run for this project type.
function installFieldTrackingTrigger() {
  const ss=getSpreadsheet_();
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction()==='onTrackedSheetEdit_') ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger('onTrackedSheetEdit_').forSpreadsheet(ss).onEdit().create();
  fieldMetaSheet_();
  return {ok:true,trigger:'onTrackedSheetEdit_',spreadsheet: ss.getName()};
}

function fieldMetaSheet_() {
  const ss=getSpreadsheet_();
  let sh=ss.getSheetByName(BRIDGE.FIELD_SYNC_SHEET);
  if (!sh) {
    sh=ss.insertSheet(BRIDGE.FIELD_SYNC_SHEET);
    sh.getRange(1,1,1,5).setValues([BRIDGE.FIELD_SYNC_HEADERS]);
    sh.hideSheet();
  }
  return sh;
}
function fieldMetaIndex_(){
  const ss=getSpreadsheet_(), sh=ss.getSheetByName(BRIDGE.FIELD_SYNC_SHEET);
  const out=Object.create(null);
  if (!sh || sh.getLastRow()<2) return out;
  const rows=sh.getRange(2,1,sh.getLastRow()-1,5).getValues();
  for (const [team,id,field,version,changedAt] of rows) {
    if (!team||!id||!field||!version||!changedAt) continue;
    const key=String(team)+'|'+String(id);
    if (!out[key]) out[key]={};
    out[key][String(field)]={version:String(version),changedAt:String(changedAt)};
  }
  return out;
}
function recordFieldTime_(team,id,field,version,at) {
  const sh=fieldMetaSheet_(),n=sh.getLastRow();
  const key=[String(team),String(id),String(field)];
  if (n>1) {
    const keys=sh.getRange(2,1,n-1,3).getValues();
    for(let i=0;i<keys.length;i++){
      if(keys[i][0]===key[0]&&keys[i][1]===key[1]&&keys[i][2]===key[2]){
        sh.getRange(i+2,4,1,2).setValues([[String(version),String(at)]]);
        return;
      }
    }
  }
  sh.appendRow(key.concat([String(version),String(at)]));
}
function onTrackedSheetEdit_(e){
  if (!e || !e.range) return;
  const sh=e.range.getSheet();
  if (sh.isSheetHidden() || !isUsableSheet_(sh)) return;
  // Event processing timestamp, not snapshot/pull timestamp.
  const at=new Date().toISOString();
  withLock_(()=>{
    const map=headerMap_(sh);
    const idCol=must_(map,['list','id']);
    const cVisited=pick_(map,['visited','visit','done']);
    const cDate=pick_(map,['lastvisiteddate','last_visited_date','visited_date','last_visit_date']);
    const columns=[
      ['noted',pick_(map,['noted'])],
      ['route',pick_(map,['route','rount','route_no','route_number','routeno','รูท','เส้นทาง'])],
      ['location',pick_(map,['location','latlng','lat_lng'])],
      ['visit',cVisited],['visit',cDate],
    ];
    const left=e.range.getColumn(),right=left+e.range.getNumColumns()-1;
    const modified=[...new Set(columns.filter(x=>x[1]>=left&&x[1]<=right).map(x=>x[0]))];
    if (!modified.length)return {ok:true,tracked:0};
    let tracked=0;
    const first=Math.max(2,e.range.getRow());
    const last=e.range.getLastRow();
    for(let row=first;row<=last;row++){
      const id=str_(sh.getRange(row,idCol).getValue());
      if (!id)continue;
      for(const field of modified){
        let value='';
        if(field==='visit'){
          const yes=cVisited?visited_(sh.getRange(row,cVisited).getValue()):false;
          const date=cDate?ymd_(sh.getRange(row,cDate).getValue()):'';
          value=(yes?'1':'0')+'|'+date;
        }else{
          const col=columns.find(x=>x[0]===field)[1];
          value=str_(sh.getRange(row,col).getValue());
        }
        recordFieldTime_(sh.getName(),id,field,digestKey_(value),at);
        tracked++;
      }
    }
    return {ok:true,tracked};
  });
}

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID is not configured');
  return SpreadsheetApp.openById(id);
}

function getSheets_() {
  const ss = getSpreadsheet_();
  const names = ss.getSheets().filter(s => !s.isSheetHidden()).filter(isUsableSheet_).map(s => s.getName());
  return { ok: true, defaultSheet: names[0] || '', sheets: names };
}

function isUsableSheet_(sheet) {
  try {
    const m = headerMap_(sheet);
    return !!(pick_(m,['list','id']) && pick_(m,['name']) && pick_(m,['location','latlng','lat_lng']) && pick_(m,['visited','visit','done']));
  } catch (_) { return false; }
}

function getPlaces_(sheetName) {
  const sheet = sheet_(sheetName);
  const rev = getRev_(sheet.getName());
  const cache = CacheService.getScriptCache();
  const cacheKey = 'places_v3_' + sheet.getName() + '_rev_' + rev;
  const cached = getChunkedCache_(cache, cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && parsed.ok) return parsed;
    } catch (_) {}
  }
  const m = headerMap_(sheet);
  const cId = must_(m,['list','id']);
  const cName = must_(m,['name']);
  const cLoc = must_(m,['location','latlng','lat_lng']);
  const cMaps = pick_(m,['google_maps','googlemaps','google map','maps','map']);
  const cVisited = pick_(m,['visited','visit','done']);
  const cLast = pick_(m,['lastvisiteddate','last_visited_date','visited_date','last_visit_date']);
  const cAccount = pick_(m,['account']);
  const cNumber = pick_(m,['number','branch','branch_number','store_no']);
  const cAccountName = pick_(m,['account_name','accountname','store_name','branch_name']);
  const cNoted = pick_(m,['noted']);
  const cRoute = pick_(m,['route','rount','route_no','route_number','routeno','รูท','เส้นทาง']);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < BRIDGE.DATA_START_ROW) {
    const empty = {ok:true,schemaVersion:3,rev,total:0,visited:0,remaining:0,places:[]};
    putChunkedCache_(cache, cacheKey, JSON.stringify(empty), BRIDGE.CACHE_TTL_SEC);
    return empty;
  }

  const values = sheet.getRange(BRIDGE.DATA_START_ROW,1,lastRow-BRIDGE.DATA_START_ROW+1,lastCol).getValues();
  const places = [];
  let visitedCount = 0;
  values.forEach(row => {
    const id = str_(row[cId-1]);
    const name = str_(row[cName-1]);
    if (!id || !name) return;
    const ll = parseLatLng_(row[cLoc-1]);
    const visited = cVisited ? visited_(row[cVisited-1]) : false;
    if (visited) visitedCount++;
    places.push({
      id, name,
      lat: ll ? ll.lat : null,
      lng: ll ? ll.lng : null,
      mapsUrl: cMaps ? str_(row[cMaps-1]) : '',
      account: cAccount ? str_(row[cAccount-1]) : '',
      number: cNumber ? str_(row[cNumber-1]) : '',
      account_name: cAccountName ? str_(row[cAccountName-1]) : '',
      noted: cNoted ? str_(row[cNoted-1]) : '',
      notedVersion: digestKey_(cNoted ? str_(row[cNoted-1]) : ''),
      route: cRoute ? str_(row[cRoute-1]) : '',
      routeVersion: digestKey_(cRoute ? str_(row[cRoute-1]) : ''),
      locationVersion: digestKey_(str_(row[cLoc-1])),
      visited,
      lastVisitedDate: cLast ? ymd_(row[cLast-1]) : '',
      visitVersion: digestKey_((visited ? 1 : 0) + '|' + (cLast ? ymd_(row[cLast-1]) : '')),
    });
  });
  const result = {ok:true,schemaVersion:3,rev,total:places.length,visited:visitedCount,
    remaining:places.length-visitedCount,places};
  putChunkedCache_(cache, cacheKey, JSON.stringify(result), BRIDGE.CACHE_TTL_SEC);
  return result;
}

function markVisited_(sheetName, id, baseVersion) {
  const s = sheet_(sheetName), m = headerMap_(s);
  const row = rowById_(s, must_(m,['list','id']), id);
  const cVisited = must_(m,['visited','visit','done']);
  const cLast = pick_(m,['lastvisiteddate','last_visited_date','visited_date','last_visit_date']);
  const oldVisited = visited_(s.getRange(row,cVisited).getValue());
  const oldDate = cLast ? ymd_(s.getRange(row,cLast).getValue()) : '';
  const currentVersion = digestKey_((oldVisited ? 1 : 0) + '|' + oldDate);
  const today = Utilities.formatDate(new Date(), BRIDGE.TIMEZONE, 'yyyy-MM-dd');
  const targetVersion = digestKey_('1|' + (cLast ? today : ''));
  if (currentVersion === targetVersion) {
    return {ok:true,rev:getRev_(s.getName()),id:String(id),visited:true,
      lastVisitedDate:cLast ? today : '',visitVersion:targetVersion};
  }
  if (baseVersion && String(baseVersion) !== currentVersion) {
    return {ok:false,error:'VERSION_CONFLICT',currentVersion};
  }
  s.getRange(row,cVisited).setValue(1);
  if (cLast) s.getRange(row,cLast).setValue(today);
  recordFieldTime_(s.getName(),String(id),'visit',targetVersion,new Date().toISOString());
  return {ok:true,rev:bumpRev_(s.getName()),id:String(id),visited:true,
    lastVisitedDate:cLast ? today : '',visitVersion:targetVersion};
}

function resetVisitedAll_(sheetName) {
  const s = sheet_(sheetName), m = headerMap_(s);
  const cVisited = must_(m,['visited','visit','done']);
  const n = Math.max(0,s.getLastRow()-BRIDGE.DATA_START_ROW+1);
  if (n) s.getRange(BRIDGE.DATA_START_ROW,cVisited,n,1).setValue(0);
  return { ok:true, rev:bumpRev_(s.getName()), reset:n, preservedLastVisitedDate:true };
}

function saveNoted_(sheetName, id, noted, baseVersion) {
  return setField_(sheetName,id,['noted'],String(noted == null ? '' : noted),'noted',baseVersion);
}

function updateRoute_(sheetName, id, route, baseVersion) {
  return setField_(sheetName,id,['route','rount','route_no','route_number','routeno','รูท','เส้นทาง'],str_(route),'route',baseVersion);
}

function updateLocation_(sheetName, id, latRaw, lngRaw, baseVersion) {
  if (latRaw == null || lngRaw == null) throw new Error('Missing coordinates');
  const lat = Number(latRaw), lng = Number(lngRaw);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat)>90 || Math.abs(lng)>180) throw new Error('Invalid coordinates');
  return setField_(sheetName,id,['location','latlng','lat_lng'],lat + ',' + lng,'location',baseVersion);
}

function setField_(sheetName,id,aliases,value,field,baseVersion) {
  const s = sheet_(sheetName), m = headerMap_(s);
  const row = rowById_(s,must_(m,['list','id']),id);
  const col = must_(m,aliases);
  const oldValue = str_(s.getRange(row,col).getValue());
  const currentVersion = digestKey_(oldValue);
  const targetValue = str_(value);
  const targetVersion = digestKey_(targetValue);
  if (currentVersion === targetVersion) {
    return {ok:true,rev:getRev_(s.getName()),id:String(id),field,value:targetValue,version:targetVersion};
  }
  if (!baseVersion || String(baseVersion) !== currentVersion) {
    return {ok:false,error:'VERSION_CONFLICT',currentVersion,currentValue:oldValue};
  }
  s.getRange(row,col).setValue(targetValue);
  recordFieldTime_(s.getName(),String(id),field,targetVersion,new Date().toISOString());
  return {ok:true,rev:bumpRev_(s.getName()),id:String(id),field,value:targetValue,version:targetVersion};
}

function reportItemsFromRows_(rows, account) {
  const wanted = str_(account).toUpperCase();
  return rows.filter(r => str_(r[0]).toUpperCase() === wanted).map(r => ({
    account:str_(r[0]), kind:str_(r[1]), id:str_(r[2]), sort:Number(r[3]||0),
    active: visited_(r[4]), data: parseJson_(r[5]), updatedAt:str_(r[6])
  })).sort((a,b) => a.sort-b.sort || a.id.localeCompare(b.id));
}

function reportConfigVersion_(items) {
  return digestKey_(JSON.stringify(items || []));
}

function getReportConfigMeta_(account) {
  const s = reportSheet_();
  const rows = s.getLastRow() > 1 ? s.getRange(2,1,s.getLastRow()-1,BRIDGE.REPORT_CONFIG_HEADERS.length).getValues() : [];
  const items = reportItemsFromRows_(rows, account);
  return {ok:true, account:str_(account), version:reportConfigVersion_(items), count:items.length};
}

function getReportConfig_(account) {
  const s = reportSheet_();
  const rows = s.getLastRow() > 1 ? s.getRange(2,1,s.getLastRow()-1,BRIDGE.REPORT_CONFIG_HEADERS.length).getValues() : [];
  const items = reportItemsFromRows_(rows, account);
  return {ok:true, account:str_(account), version:reportConfigVersion_(items), items};
}

function saveReportConfigBulk_(items, requestId, baseVersion) {
  if (!Array.isArray(items) || !items.length) throw new Error('items must be a nonempty array');
  const accountKey = str_(items[0].account).toUpperCase();
  if (!accountKey) throw new Error('Invalid config account');

  const now = new Date().toISOString();
  const normalizedItems = items.map(x => {
    const account = str_(x.account), kind = str_(x.kind), id = str_(x.id);
    if (!account || account.toUpperCase() !== accountKey || !kind || !id) {
      throw new Error('Invalid config item');
    }
    return {
      account, kind, id, sort:Number(x.sort||0), active:x.active !== false,
      data:x.data == null ? {} : x.data,
      updatedAt:str_(x.updatedAt) || now
    };
  }).sort((a,b) => a.sort-b.sort || a.id.localeCompare(b.id));
  const targetVersion = reportConfigVersion_(normalizedItems);

  const s = reportSheet_();
  const lastRow = s.getLastRow();
  const previous = lastRow > 1
    ? s.getRange(2,1,lastRow-1,BRIDGE.REPORT_CONFIG_HEADERS.length).getValues()
    : [];
  const currentItems = reportItemsFromRows_(previous, accountKey);
  const currentVersion = reportConfigVersion_(currentItems);
  if (currentVersion === targetVersion) {
    return {ok:true,count:normalizedItems.length,version:targetVersion,requestId:str_(requestId)};
  }
  if (!baseVersion || String(baseVersion) !== currentVersion) {
    return {ok:false,error:'VERSION_CONFLICT',currentVersion};
  }

  const normalizedRows = normalizedItems.map(x => [
    x.account, x.kind, x.id, x.sort, x.active ? 1 : 0,
    JSON.stringify(x.data), x.updatedAt
  ]);
  const kept = previous.filter(row => str_(row[0]).toUpperCase() !== accountKey);
  const combined = kept.concat(normalizedRows);

  if (combined.length) {
    s.getRange(2,1,combined.length,BRIDGE.REPORT_CONFIG_HEADERS.length).setValues(combined);
  }
  if (lastRow-1 > combined.length) {
    s.getRange(2+combined.length,1,lastRow-1-combined.length,BRIDGE.REPORT_CONFIG_HEADERS.length).clearContent();
  }

  const props = PropertiesService.getScriptProperties();
  const rev = Number(props.getProperty('REPORT_CONFIG_REV') || 1) + 1;
  props.setProperty('REPORT_CONFIG_REV',String(rev));
  return {ok:true,count:normalizedItems.length,version:targetVersion,requestId:str_(requestId)};
}

function freshStoresForSnapshot_(sheet) {
  const m = headerMap_(sheet);
  const cId = must_(m,['list','id']);
  const cName = must_(m,['name']);
  const cLoc = must_(m,['location','latlng','lat_lng']);
  const cMaps = pick_(m,['google_maps','googlemaps','google map','maps','map']);
  const cVisited = pick_(m,['visited','visit','done']);
  const cLast = pick_(m,['lastvisiteddate','last_visited_date','visited_date','last_visit_date']);
  const cAccount = pick_(m,['account']);
  const cNumber = pick_(m,['number','branch','branch_number','store_no']);
  const cAccountName = pick_(m,['account_name','accountname','store_name','branch_name']);
  const cNoted = pick_(m,['noted']);
  const cRoute = pick_(m,['route','rount','route_no','route_number','routeno','รูท','เส้นทาง']);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < BRIDGE.DATA_START_ROW) return [];
  const values = sheet.getRange(
    BRIDGE.DATA_START_ROW,1,lastRow-BRIDGE.DATA_START_ROW+1,lastCol
  ).getValues();
  return values.map(row => {
    const id = str_(row[cId-1]);
    const name = str_(row[cName-1]);
    if (!id || !name) return null;
    return {
      id:id,
      name:name,
      locationRaw:str_(row[cLoc-1]),
      mapsUrl:cMaps ? str_(row[cMaps-1]) : '',
      visited:cVisited ? visited_(row[cVisited-1]) : false,
      account:cAccount ? str_(row[cAccount-1]) : '',
      number:cNumber ? str_(row[cNumber-1]) : '',
      account_name:cAccountName ? str_(row[cAccountName-1]) : '',
      lastVisitedDate:cLast ? ymd_(row[cLast-1]) : '',
      route:cRoute ? str_(row[cRoute-1]) : '',
      noted:cNoted ? str_(row[cNoted-1]) : ''
    };
  }).filter(Boolean);
}

function freshReportConfigSetsForSnapshot_() {
  const s = reportSheet_();
  const rows = s.getLastRow() > 1
    ? s.getRange(2,1,s.getLastRow()-1,BRIDGE.REPORT_CONFIG_HEADERS.length).getValues()
    : [];
  const accounts = {};
  rows.forEach(row => {
    const account = str_(row[0]);
    const kind = str_(row[1]);
    const id = str_(row[2]);
    if (!account || !kind || !id) return;
    if (!accounts[account]) accounts[account] = [];
    accounts[account].push({
      account:account,
      kind:kind,
      id:id,
      sort:Number(row[3]||0),
      active:visited_(row[4]),
      data:parseJson_(row[5]),
      updatedAt:str_(row[6])
    });
  });
  return Object.keys(accounts).sort().map(account => ({
    account:account,
    items:accounts[account].sort((a,b) => a.sort-b.sort || a.id.localeCompare(b.id))
  }));
}

function buildFreshSheetSnapshot_() {
  const ss = getSpreadsheet_();
  const fieldTimes=fieldMetaIndex_();
  const teams = ss.getSheets()
    .filter(s => !s.isSheetHidden())
    .filter(isUsableSheet_)
    .map(s => ({
      teamId:s.getName(),
      name:s.getName(),
      stores:freshStoresForSnapshot_(s).map(store=>({
        ...store,fieldMeta:fieldTimes[s.getName()+'|'+store.id]||{}
      }))
    }));
  return {
    complete:true,
    generatedAt:new Date().toISOString(),
    teams:teams,
    reportConfigSets:freshReportConfigSetsForSnapshot_()
  };
}

function reportSheet_() {
  const ss = getSpreadsheet_();
  let s = ss.getSheetByName(BRIDGE.REPORT_CONFIG_SHEET);
  if (!s) {
    s = ss.insertSheet(BRIDGE.REPORT_CONFIG_SHEET);
    s.getRange(1,1,1,BRIDGE.REPORT_CONFIG_HEADERS.length).setValues([BRIDGE.REPORT_CONFIG_HEADERS]);
  }
  return s;
}

function sheet_(name) {
  const ss = getSpreadsheet_();
  const s = ss.getSheetByName(str_(name));
  if (!s || s.isSheetHidden() || !isUsableSheet_(s)) throw new Error('Unknown or unusable sheet');
  return s;
}

function headerMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (!lastCol) return {};
  const vals = sheet.getRange(BRIDGE.HEADER_ROW,1,1,lastCol).getValues()[0];
  const m = {};
  vals.forEach((v,i) => { const k=norm_(v); if (k && !m[k]) m[k]=i+1; });
  return m;
}

function norm_(v) { return str_(v).toLowerCase().replace(/\u200b/g,'').replace(/\s+/g,'_').replace(/[^\wก-๙_]/g,''); }
function pick_(m,a) { for (let i=0;i<a.length;i++){ const k=norm_(a[i]); if(m[k]) return m[k]; } return 0; }
function must_(m,a) { const c=pick_(m,a); if(!c) throw new Error('Missing required column: '+a.join('/')); return c; }

function rowById_(s,idCol,id) {
  const n=Math.max(0,s.getLastRow()-BRIDGE.DATA_START_ROW+1);
  if (!n) throw new Error('Store not found');
  const cell=s.getRange(BRIDGE.DATA_START_ROW,idCol,n,1).createTextFinder(String(id)).matchEntireCell(true).matchCase(false).findNext();
  if (!cell) throw new Error('Store not found');
  return cell.getRow();
}

function getRev_(sheetName) { return Number(PropertiesService.getScriptProperties().getProperty('REV_'+digestKey_(sheetName)) || 1); }
function bumpRev_(sheetName) { const n=getRev_(sheetName)+1; PropertiesService.getScriptProperties().setProperty('REV_'+digestKey_(sheetName),String(n)); return n; }

function getChunkedCache_(cache, cacheKey) {
  try {
    const direct = cache.get(cacheKey);
    if (direct) return direct;
    const count = parseInt(cache.get(cacheKey + '_parts') || '0', 10);
    if (!isFinite(count) || count < 1) return null;
    const parts = [];
    for (let i = 0; i < count; i++) {
      const part = cache.get(cacheKey + '_part_' + i);
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join('');
  } catch (_) { return null; }
}

function putChunkedCache_(cache, cacheKey, value, ttlSec) {
  try {
    const partCount = Math.ceil(value.length / BRIDGE.CACHE_CHUNK_CHARS);
    for (let i = 0; i < partCount; i++) {
      cache.put(cacheKey + '_part_' + i,
        value.slice(i * BRIDGE.CACHE_CHUNK_CHARS, (i + 1) * BRIDGE.CACHE_CHUNK_CHARS), ttlSec);
    }
    cache.put(cacheKey + '_parts', String(partCount), ttlSec);
  } catch (_) {}
}

function digestKey_(v) { return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(v),Utilities.Charset.UTF_8)).replace(/=+$/g,'').slice(0,32); }
function parseLatLng_(v) { const m=str_(v).match(/-?\d+(?:\.\d+)?/g); if(!m||m.length<2)return null; const lat=Number(m[0]),lng=Number(m[1]); return isFinite(lat)&&isFinite(lng)?{lat,lng}:null; }
function visited_(v) { if(v===true)return true; const s=str_(v).toLowerCase(); return ['1','true','yes','y','done','visited'].indexOf(s)!==-1; }
function ymd_(v) { if(Object.prototype.toString.call(v)==='[object Date]'&&!isNaN(v)) return Utilities.formatDate(v,BRIDGE.TIMEZONE,'yyyy-MM-dd'); const s=str_(v); return s ? s.slice(0,10) : ''; }
function parseJson_(v) { if(v && typeof v==='object')return v; try{return JSON.parse(String(v||'{}'));}catch(_){return{};} }
function str_(v) { return v===null||v===undefined?'':String(v).trim(); }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

function cleanupIdempotencyProps_(props, nowMs) {
  const nextAt = Number(props.getProperty('IDEMP_GC_NEXT_AT') || 0);
  if (nowMs < nextAt) return;
  const cutoff = nowMs - BRIDGE.IDEMPOTENCY_TTL_SEC * 1000;
  const all = props.getProperties();
  Object.keys(all).forEach(key => {
    if (key === 'IDEMP_GC_NEXT_AT' || key.indexOf('IDEMP_') !== 0) return;
    try {
      const item = JSON.parse(all[key] || 'null');
      const started = item && item.startedAt ? Date.parse(item.startedAt) : NaN;
      if (isFinite(started) && started < cutoff) props.deleteProperty(key);
    } catch (_) {}
  });
  props.setProperty(
    'IDEMP_GC_NEXT_AT',
    String(nowMs + BRIDGE.IDEMPOTENCY_GC_INTERVAL_SEC * 1000)
  );
}

function runMutation_(action, params, requestId) {
  return withLock_(() => {
    const props = PropertiesService.getScriptProperties();
    cleanupIdempotencyProps_(props, Date.now());
    const key = 'IDEMP_' + digestKey_(requestId);
    const hash = digestKey_(JSON.stringify({action, params}));
    const previous = JSON.parse(props.getProperty(key) || 'null');
    if (previous) {
      if (previous.hash !== hash) return {ok:false,error:'IDEMPOTENCY_CONFLICT'};
      if (previous.status === 'done') return previous.result;
      return {ok:false,error:'INDETERMINATE_REQUIRES_RECONCILIATION'};
    }
    const startedAt = new Date().toISOString();
    props.setProperty(key, JSON.stringify({hash, status:'pending', startedAt}));
    const result = dispatch_(action, params, requestId);
    if (result && typeof result.ok === 'boolean') {
      props.setProperty(key, JSON.stringify({hash, status:'done', startedAt, result}));
    }
    return result;
  });
}
