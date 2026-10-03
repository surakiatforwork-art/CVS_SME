(function(root){
  'use strict';

  // The static frontend must never contain a Worker service token. A future
  // authenticated pilot can provide a short-lived authorization header in memory.
  function create(options){
    options = options || {};
    var legacy = options.legacy || {};
    var workerUrl = String(options.workerUrl || '').replace(/\/+$/, '');
    var getAuthorization = options.getAuthorization;
    var versions = Object.create(null);
    var configVersions = Object.create(null);

    function workerReady(){
      return options.mode === 'worker' && workerUrl && typeof getAuthorization === 'function';
    }

    function storeKey(teamId, storeId){
      return String(teamId || '') + '|' + String(storeId || '');
    }

    function rememberVersions(teamId, stores){
      (stores || []).forEach(function(store){
        versions[storeKey(teamId, store.id)] = {
          noted: String(store.notedVersion || ''),
          route: String(store.routeVersion || ''),
          location: String(store.locationVersion || ''),
          visit: String(store.visitVersion || '')
        };
      });
    }

    async function request(path, init, retried){
      if(!workerReady()) throw new Error('Worker requires browser-safe authentication');
      var authorization = await getAuthorization();
      if(!authorization || typeof authorization !== 'string') {
        throw new Error('Worker authentication is unavailable');
      }
      var headers = Object.assign({ Accept:'application/json', Authorization:authorization }, init.headers || {});
      var response = await fetch(workerUrl + path, Object.assign({}, init, { headers:headers }));
      var body;
      try { body = await response.json(); }
      catch(_) { throw new Error('Worker returned invalid JSON'); }
      if((response.status === 401 || (response.status === 403 && body && body.error === 'Forbidden')) &&
          !retried && typeof options.clearAuthorization === 'function'){
        options.clearAuthorization();
        return request(path, init, true);
      }
      if(!response.ok || !body || body.ok === false) {
        var error = new Error((body && (body.message || body.error)) || ('Worker HTTP ' + response.status));
        error.code = body && body.error;
        error.status = response.status;
        error.response = body;
        throw error;
      }
      return body;
    }

    function getVersion(teamId, storeId, field){
      var entry = versions[storeKey(teamId, storeId)];
      return entry && entry[field] || '';
    }

    function rememberVersion(teamId, storeId, field, version){
      var key = storeKey(teamId, storeId);
      versions[key] = versions[key] || {};
      versions[key][field] = String(version || '');
    }

    async function workerTeams(){
      var result = await request('/v1/teams', { method:'GET' });
      return {
        ok:true,
        defaultSheet:result.defaultTeamId || '',
        sheets:(result.teams || []).map(function(team){ return team.id; })
      };
    }

    async function workerPlaces(sheetName){
      var teamId = encodeURIComponent(String(sheetName || ''));
      var result = await request('/v1/teams/' + teamId + '/stores', { method:'GET' });
      rememberVersions(result.teamId, result.stores || []);
      return {
        ok:true,
        schemaVersion:result.schemaVersion || 3,
        rev:result.revision || '',
        total:Number(result.total || 0),
        visited:Number(result.visited || 0),
        remaining:Number(result.remaining || 0),
        places:result.stores || []
      };
    }

    async function workerReportConfig(account){
      var key = String(account || '').trim();
      var result = await request('/v1/report-config/' + encodeURIComponent(key), {method:'GET'});
      configVersions[key] = String(result.version || '');
      return result;
    }

    async function workerMutation(path, method, body, requestId){
      var headers = { 'content-type':'application/json' };
      if(requestId) headers['Idempotency-Key'] = requestId;
      return request(path, { method:method, headers:headers, body:JSON.stringify(body || {}) });
    }

    async function workerSaveReportConfig(account, items, requestId, baseVersion){
      var key = String(account || '').trim();
      var version = baseVersion === undefined || baseVersion === null ? configVersions[key] : String(baseVersion);
      if(version === undefined || version === null) version = '';
      var result = await workerMutation('/v1/report-config/' + encodeURIComponent(key), 'PUT', {
        items:items || [],
        baseVersion:String(version)
      }, requestId);
      configVersions[key] = String(result.version || '');
      return result;
    }

    return {
      mode:function(){ return workerReady() ? 'worker' : 'apps-script'; },
      listTeams:function(){ return workerReady() ? workerTeams() : legacy.listTeams(); },
      getPlaces:function(sheetName){ return workerReady() ? workerPlaces(sheetName) : legacy.getPlaces(sheetName); },
      getReportConfig:function(account){
        if(!workerReady()) return legacy.getReportConfig(account);
        return workerReportConfig(account);
      },
      saveReportConfig:function(account, items, requestId, baseVersion){
        if(!workerReady()) return legacy.saveReportConfig(account, items, requestId, baseVersion);
        return workerSaveReportConfig(account, items, requestId, baseVersion);
      },
      markVisited:async function(id, sheetName, requestId){
        if(!workerReady()) return legacy.markVisited(id, sheetName, requestId);
        var result = await workerMutation('/v1/teams/' + encodeURIComponent(sheetName) + '/stores/' + encodeURIComponent(id) + '/visits', 'POST', {}, requestId);
        rememberVersion(sheetName, id, 'visit', result.visitVersion);
        return result;
      },
      resetVisits:function(sheetName, requestId){
        if(!workerReady()) return legacy.resetVisits(sheetName, requestId);
        return workerMutation('/v1/teams/' + encodeURIComponent(sheetName) + '/visits/reset', 'POST', {}, requestId);
      },
      saveNoted:async function(id, noted, sheetName, requestId){
        if(!workerReady()) return legacy.saveNoted(id, noted, sheetName, requestId);
        var baseVersion = getVersion(sheetName, id, 'noted');
        if(!baseVersion) throw new Error('Missing noted version; refresh this sheet before retrying');
        var result = await workerMutation('/v1/teams/' + encodeURIComponent(sheetName) + '/stores/' + encodeURIComponent(id) + '/noted', 'PUT', { noted:noted, baseVersion:baseVersion }, requestId);
        rememberVersion(sheetName, id, 'noted', result.version);
        return result;
      },
      updateRoute:async function(id, route, sheetName, requestId){
        if(!workerReady()) return legacy.updateRoute(id, route, sheetName, requestId);
        var baseVersion = getVersion(sheetName, id, 'route');
        if(!baseVersion) throw new Error('Missing route version; refresh this sheet before retrying');
        var result = await workerMutation('/v1/teams/' + encodeURIComponent(sheetName) + '/stores/' + encodeURIComponent(id) + '/route', 'PATCH', { value:route, baseVersion:baseVersion }, requestId);
        rememberVersion(sheetName, id, 'route', result.version);
        return result;
      },
      updateLocation:async function(id, lat, lng, sheetName, requestId){
        if(!workerReady()) return legacy.updateLocation(id, lat, lng, sheetName, requestId);
        var baseVersion = getVersion(sheetName, id, 'location');
        if(!baseVersion) throw new Error('Missing location version; refresh this sheet before retrying');
        var result = await workerMutation('/v1/teams/' + encodeURIComponent(sheetName) + '/stores/' + encodeURIComponent(id) + '/location', 'PATCH', { lat:lat, lng:lng, baseVersion:baseVersion }, requestId);
        rememberVersion(sheetName, id, 'location', result.version);
        return result;
      }
    };
  }

  root.PTBackendClient = { create:create };
})(window);
