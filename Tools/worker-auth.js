(function(root){
  'use strict';

  var WORKER_URL = 'https://cvs-sme-api.surakiat16082000.workers.dev';
  var STORAGE_KEY = 'PT_WORKER_SESSION_V1';
  var pendingLogin = null;

  function readSession(){
    try{
      var raw = sessionStorage.getItem(STORAGE_KEY);
      var s = raw ? JSON.parse(raw) : null;
      if(!s || !s.token || !s.role || !s.expiresAt) return null;
      var exp = Date.parse(s.expiresAt);
      if(!Number.isFinite(exp) || exp <= Date.now() + 30000){
        sessionStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return s;
    }catch(_){ return null; }
  }

  function saveSession(s){
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      token:String(s.token || ''),
      role:String(s.role || ''),
      expiresAt:String(s.expiresAt || '')
    }));
  }

  function clearSession(){
    try{ sessionStorage.removeItem(STORAGE_KEY); }catch(_){}
  }

  function roleAllows(actual, required){
    if(required === 'admin') return actual === 'admin';
    return actual === 'user' || actual === 'admin';
  }

  function requestAccessCode(requiredRole){
    return new Promise(function(resolve,reject){
      var old = document.getElementById('ptWorkerAuthOverlay');
      if(old) old.remove();

      var overlay=document.createElement('div');
      overlay.id='ptWorkerAuthOverlay';
      overlay.style.cssText='position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:20px;background:rgba(10,35,33,.62);font-family:Tahoma,"Noto Sans Thai",sans-serif';
      var card=document.createElement('form');
      card.style.cssText='width:min(380px,100%);background:#fff;border-radius:18px;padding:20px;box-shadow:0 18px 55px rgba(0,0,0,.28);color:#183c39';
      var title=document.createElement('div');
      title.textContent=requiredRole==='admin'?'เข้าสู่ระบบผู้ดูแล':'เข้าสู่ระบบ';
      title.style.cssText='font-weight:800;font-size:20px;margin-bottom:6px';
      var hint=document.createElement('div');
      hint.textContent=requiredRole==='admin'?'กรอกรหัสผู้ดูแลระบบ':'กรอกรหัสเข้าใช้งาน';
      hint.style.cssText='font-size:13px;color:#54716d;margin-bottom:12px';
      var input=document.createElement('input');
      input.type='password';
      input.autocomplete='current-password';
      input.required=true;
      input.placeholder='รหัสเข้าใช้งาน';
      input.style.cssText='width:100%;box-sizing:border-box;border:1px solid #b9dfd9;border-radius:11px;padding:12px;font:inherit;color:#183c39';
      var error=document.createElement('div');
      error.style.cssText='min-height:18px;margin-top:7px;color:#b64242;font-size:12px';
      var actions=document.createElement('div');
      actions.style.cssText='display:flex;gap:8px;margin-top:10px';
      var submit=document.createElement('button');
      submit.type='submit'; submit.textContent='เข้าสู่ระบบ';
      submit.style.cssText='flex:1;border:0;border-radius:11px;padding:11px;background:#1f8178;color:#fff;font:inherit;font-weight:700';
      var cancel=document.createElement('button');
      cancel.type='button'; cancel.textContent='ยกเลิก';
      cancel.style.cssText='border:0;border-radius:11px;padding:11px;background:#e7f4f1;color:#183c39;font:inherit;font-weight:700';
      actions.append(submit,cancel);
      card.append(title,hint,input,error,actions);
      overlay.append(card);
      document.body.append(overlay);

      function cleanup(){ input.value=''; overlay.remove(); }
      cancel.onclick=function(){ cleanup(); reject(new Error('ยกเลิกการเข้าสู่ระบบ')); };
      overlay.addEventListener('click',function(e){ if(e.target===overlay) cancel.click(); });
      card.addEventListener('submit',function(e){
        e.preventDefault();
        var value=String(input.value||'').trim();
        if(!value){ error.textContent='กรุณากรอกรหัสเข้าใช้งาน'; input.focus(); return; }
        cleanup(); resolve(value);
      });
      setTimeout(function(){ input.focus(); },0);
    });
  }

  async function login(requiredRole){
    var isAdmin = requiredRole === 'admin';
    var code = isAdmin ? await requestAccessCode(requiredRole) : '';
    var response = await fetch(WORKER_URL + (isAdmin ? '/auth/login' : '/auth/user-session'), {
      method:'POST',
      headers:{'content-type':'application/json','accept':'application/json'},
      body:isAdmin ? JSON.stringify({code:code}) : '{}'
    });
    code='';
    var body = null;
    try{ body = await response.json(); }catch(_){}
    if(!response.ok || !body || !body.ok){
      var message=(body && (body.message || body.error)) || 'เข้าสู่ระบบไม่สำเร็จ';
      if(response.status===429) message='ลองรหัสผิดหลายครั้ง กรุณารอสักครู่แล้วลองใหม่';
      throw new Error(message);
    }
    if(!roleAllows(String(body.role || ''), requiredRole)){
      throw new Error('บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ');
    }
    saveSession(body);
    return readSession();
  }

  async function ensureSession(requiredRole){
    requiredRole = requiredRole === 'admin' ? 'admin' : 'user';
    var s = readSession();
    if(s && roleAllows(s.role, requiredRole)) return s;
    if(pendingLogin) {
      s = await pendingLogin;
      if(s && roleAllows(s.role, requiredRole)) return s;
    }
    pendingLogin = login(requiredRole);
    try{ return await pendingLogin; }
    finally{ pendingLogin = null; }
  }

  async function getAuthorization(requiredRole){
    var s = await ensureSession(requiredRole || 'user');
    return 'Bearer ' + s.token;
  }

  async function getRole(){
    var s = readSession();
    return s ? s.role : '';
  }

  root.PTWorkerAuth = {
    workerUrl:WORKER_URL,
    ensureSession:ensureSession,
    getAuthorization:getAuthorization,
    clearSession:clearSession,
    getRole:getRole
  };

  var params = new URLSearchParams(root.location && root.location.search || '');
  var forcedLegacy = params.get('backend') === 'legacy';
  root.__PT_WORKER_PILOT__ = forcedLegacy ? {mode:'apps-script'} : {
    mode:'worker',
    getAuthorization:function(){ return getAuthorization('user'); },
    clearAuthorization:clearSession
  };
})(window);
