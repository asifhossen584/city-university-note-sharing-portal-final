"use strict";
      const { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } = React;
      const html = htm.bind(React.createElement);
      const REDUCED_MOTION = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

/* ================= API (Node.js + Express + MySQL backend) =================
   Every bit of data comes from the backend API. Change API_BASE if the
   backend runs somewhere else (or set window.NOTES_PORTAL_API_BASE before
   this file loads). The login session lives in an HttpOnly cookie, so every
   request sends credentials:'include'. No password or demo account exists
   in this file — login goes through POST /api/login only.
   The API host follows the host the page was opened on (localhost or
   127.0.0.1): the session cookie is SameSite=Lax, so if the page is on
   127.0.0.1 while the API is on localhost, the browser silently drops the
   cookie on every call after login and each one fails as "Please log in
   first." even though the header already shows the user as signed in. */
      const API_BASE = (window.NOTES_PORTAL_API_BASE || ("http://" + (window.location.hostname || "localhost") + ":3000")) + "/api";
      function fileUrl(noteId, download){
        return API_BASE + "/notes/" + noteId + "/file?download=" + (download ? "1" : "0");
      }
      async function api(path, opts){
        opts = opts || {};
        const res = await fetch(API_BASE + path, {
          method: opts.method || "GET",
          credentials: "include",
          headers: opts.body ? { "Content-Type": "application/json" } : {},
          body: opts.body ? JSON.stringify(opts.body) : undefined
        });
        let data = null;
        try{ data = await res.json(); }catch(e){ data = null; }
        if(!res.ok){
          const msg = (data && data.error) || ("Request failed (" + res.status + ").");
          const err = new Error(msg); err.status = res.status;
          err.code = (data && data.code) || null; /* e.g. EMAIL_NOT_VERIFIED */
          throw err;
        }
        return data || {};
      }
      /* "Semester 1" .. "Semester 12" (the API's strings) <-> 1 .. 12 (numbers) */
      const semNum = s => { const m = /(\d+)/.exec(String(s||"")); return m ? Number(m[1]) : 0; };
      const semStr = n => "Semester " + n;
      /* Normalise an API course row to the shape the views use */
      function normCourse(c){
        return { id:c.id, dept:c.dept, sem:semNum(c.sem), code:c.code, title:c.title };
      }
      /* Normalise an API note row. The API embeds the course info, the
         uploader's name and the rating summary on every note. */
      function normNote(n){
        return {
          id:n.id, userId:n.userId, courseId:n.courseId, title:n.title, desc:n.desc,
          fileName:n.fileName, fileType:n.fileType || fileTypeOf({fileName:n.fileName}),
          fileSize:n.fileSize, status:n.status, created:n.created, downloads:n.downloads,
          code:n.code, courseTitle:n.courseTitle, dept:n.dept, sem:n.sem,
          uploader:n.uploader, avg:typeof n.avg==="number" ? n.avg : 0,
          count:typeof n.count==="number" ? n.count : 0,
          fileData:null, lines:[]
        };
      }
      /* Normalise an API user row (fullUser shape) to the shape the views use */
      function normUser(u){
        if(!u) return null;
        return { id:u.id, name:u.name, email:u.email, role:u.role, dept:u.dept,
                 studentId:u.studentId || "", phone:u.phone || "",
                 approved:!!u.approved, suspended:!!u.suspended, joined:u.joined,
                 photo:u.photo || null, notes:u.notes };
      }
      /* Empty client state — filled in from the API on load. The dark-mode
         choice is the only thing kept in localStorage (a UI preference). */
      const THEME_KEY = "notesPortalThemeV1";
      function emptyState(){
        return { users:[], courses:[], departments:[], adminDepartments:[], notes:[], myNotes:[], adminNotes:[], notices:[],
                 ratings:[], comments:[], bookmarks:[], myRatings:{},
                 tickets:[], adminTickets:[],
                 session:null, me:null, stats:null, pendingUsers:[],
                 loading:true, apiError:"" };
      }
      /* Departments come from the API (the Admin panel manages them); the
         hard-coded list is only the fallback until the API answers. */
      const deptList = st => (st.departments && st.departments.length ? st.departments : DEPARTMENTS);

      /* ================= Helpers ================= */
      /* Space-insensitive compare only: a typed "CSE1101" must match the
         catalogue's "CSE 1101". Codes are STORED exactly as typed (only
         auto-capitalised) — see cleanCode below. */
      const normCode = v => String(v||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
      const cleanCode = v => String(v||"").trim().toUpperCase().slice(0,30);
      const sanitizeCodeInput = v => cleanCode(v);
      const fmtDate = ts => new Date(ts).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});
      function fmtSize(bytes){
        if(!bytes) return "0 B";
        if(bytes < 1024) return bytes+" B";
        if(bytes < 1024*1024) return (bytes/1024).toFixed(1)+" KB";
        return (bytes/(1024*1024)).toFixed(1)+" MB";
      }
      function initials(name){
        return String(name||"").split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join("");
      }
      /* Roles: admin runs everything, a moderator helps with approvals,
         notes and notices, a student just uses the library. */
      const isAdminUser = u => !!u && u.role==="admin";
      const isStaffUser = u => !!u && (u.role==="admin" || u.role==="moderator");
      const roleLabelOf = u => !u ? "" : u.role==="admin" ? "Admin" : u.role==="moderator" ? "Moderator" : "Student";
      function fileTypeOf(note){
        const m = /\.([a-z0-9]+)$/i.exec(note.fileName||"");
        return m ? m[1].toLowerCase() : "pdf";
      }
      function useDebounced(value, ms){
        const [v,setV] = useState(value);
        useEffect(()=>{ const t = setTimeout(()=>setV(value), ms); return ()=>clearTimeout(t); },[value,ms]);
        return v;
      }
      /* Rating summary for a note. The API embeds avg/count on every note,
         so use that when present; otherwise fall back to the local ratings. */
      function avgRating(ratings, noteId, note){
        if(note && typeof note.avg==="number") return { avg:note.avg, count:note.count||0 };
        const rs = (ratings||[]).filter(r=>r.noteId===noteId);
        if(!rs.length) return { avg:0, count:0 };
        return { avg: rs.reduce((a,r)=>a+r.value,0)/rs.length, count: rs.length };
      }
      /* Files live on the backend now (uploads/ on the server). A PDF or
         photo is shown straight from the API; downloading opens the API
         download link, which also counts the download on the server. */
      const UPLOAD_FILE_MAX = 10*1024*1024;
      const IMAGE_TYPES = ["png","jpg","jpeg","gif","webp"];
      function noteFileKind(note){
        const t = fileTypeOf(note);
        if(IMAGE_TYPES.indexOf(t)>=0) return "image";
        if(t==="pdf") return "pdf";
        return "other";
      }
      /* Download the real file from the API (login required; the server
         counts the download). A plain link click sends the session cookie. */
      function downloadNoteFile(note){
        const a = document.createElement("a");
        a.href = fileUrl(note.id, true);
        a.download = note.fileName || "note";
        document.body.appendChild(a); a.click(); a.remove();
      }
      /* Avatar: show the user's photo when they have one, initials otherwise */
      function Avatar({ user, cls }){
        const photo = user && user.photo;
        return html`<span class=${(cls || "avatar") + (photo ? " has-photo" : "")} aria-hidden="true">${photo
          ? html`<img src=${photo} alt="" />`
          : initials(user ? user.name : "?")}</span>`;
      }
      /* Dark mode: the choice is a UI preference, kept in localStorage only */
      function currentTheme(){
        try{ return localStorage.getItem(THEME_KEY) || "light"; }catch(e){ return "light"; }
      }
      function applyTheme(t){
        document.documentElement.setAttribute("data-theme", t==="dark" ? "dark" : "light");
        try{ localStorage.setItem(THEME_KEY, t); }catch(e){}
      }
      function ThemeButton({ theme, onToggle }){
        return html`<button type="button" class="theme-btn"
          aria-label=${theme==="dark" ? "Switch to light mode" : "Switch to dark mode"}
          title=${theme==="dark" ? "Light mode" : "Dark mode"} onClick=${onToggle}>
          <${Icon} name=${theme==="dark" ? "sun" : "moon"} size=${18} /></button>`;
      }

      /* ================= Icons (Lucide-style line icons) ================= */
      const PATHS = {
        search: html`<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`,
        check: html`<path d="M20 6 9 17l-5-5"/>`,
        download: html`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>`,
        upload: html`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>`,
        eye: html`<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>`,
        building: html`<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>`,
        eyeOff: html`<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-4.493 4.223"/><path d="M6.97 6.97C4.606 8.325 2.71 10.428 2.062 12.348a1 1 0 0 0 0 .696 10.752 10.752 0 0 0 3.545 3.65"/><path d="m2 2 20 20"/><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/>`,
        star: html`<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>`,
        bookmark: html`<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>`,
        shield: html`<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>`,
        chevronR: html`<path d="m9 18 6-6-6-6"/>`,
        chevronD: html`<path d="m6 9 6 6 6-6"/>`,
        bell: html`<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`,
        user: html`<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`,
        clock: html`<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`,
        logout: html`<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>`,
        menu: html`<line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/>`,
        x: html`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
        fileText: html`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>`,
        pencil: html`<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>`,
        trash: html`<path d="M3 6h18"/><path d="M19 20v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>`,
        megaphone: html`<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>`,
        pin: html`<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>`,
        ban: html`<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>`,
        users: html`<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
        moon: html`<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`,
        sun: html`<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>`
      };
      function Icon({ name, size, sw }){
        return html`<svg class="ic" width=${size||20} height=${size||20} viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth=${sw||2} strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true">${PATHS[name]}</svg>`;
      }

      /* ================= Shared components ================= */
      function Stars({ avg, count }){
        const pct = Math.max(0, Math.min(100, (avg/5)*100));
        return html`<span class="stars-wrap">
          <span class="stars" style=${{"--v":pct+"%"}}>★★★★★</span>
          <span class="val">${avg ? avg.toFixed(1) : "—"}</span>
          <span class="cnt">(${count})</span>
        </span>`;
      }
      /* Animated number — counts up with an ease-out when it mounts or changes.
         The clock starts on the FIRST animation frame (never performance.now()
         mixed with the frame timestamp — the two clocks can have different
         origins and send the count to huge negative numbers), and progress
         is clamped to [0,1] so the number always settles on the real value. */
      function CountUp({ value }){
        const [n,setN] = useState(REDUCED_MOTION ? value : 0);
        useEffect(()=>{
          if(REDUCED_MOTION){ setN(value); return; }
          let raf; let t0 = null; const dur = 1300;
          const tick = t=>{
            if(t0===null) t0 = t;
            const p = Math.max(0, Math.min(1,(t-t0)/dur));
            setN(Math.round(value * (1 - Math.pow(1-p,4))));
            if(p<1) raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
          return ()=>cancelAnimationFrame(raf);
        },[value]);
        return html`${n}`;
      }
      /* Password field with a show/hide (eye) toggle at the right edge.
         Used on every password box: Login, Register, Forgot-password reset,
         Profile Change password and Admin Add staff. */
      function PasswordInput({ label, hint, value, onInput, autoComplete, required, minLength, placeholder }){
        const [show,setShow] = useState(false);
        return html`<${Field} label=${label} hint=${hint || null}>
          <span class="pw-wrap">
            <input aria-label=${label} class="in pw-in" type=${show ? "text" : "password"}
              autoComplete=${autoComplete || "off"} required=${!!required} minLength=${minLength || null}
              placeholder=${placeholder || ""} value=${value} onInput=${onInput} />
            <button type="button" class="pw-eye" aria-label=${show ? "Hide password" : "Show password"}
              aria-pressed=${show} title=${show ? "Hide password" : "Show password"}
              onClick=${()=>setShow(!show)}>
              <${Icon} name=${show ? "eyeOff" : "eye"} size=${18} />
            </button>
          </span>
        </${Field}>`;
      }
      function FileBadge({ type }){
        const t = String(type||"pdf").toLowerCase();
        return html`<span class=${"file-badge fb-"+t}>${t.toUpperCase()}</span>`;
      }
      function StatusBadge({ status }){
        return html`<span class=${"badge-status "+status}>${status}</span>`;
      }
      function AlertBox({ kind, children }){
        return html`<div class=${"alert "+kind} role=${kind==="error" ? "alert" : "status"}>${children}</div>`;
      }
      function EmptyState({ title, body, children }){
        return html`<div class="empty">
          <${Icon} name="fileText" size=${40} />
          <p class="t">${title}</p>
          <p class="b">${body}</p>
          ${children}
        </div>`;
      }
      function Field({ label, hint, children }){
        return html`<div class="field">
          <span class="lbl">${label}</span>
          ${children}
          ${hint ? html`<p class="hint">${hint}</p>` : null}
        </div>`;
      }

            function NoteCard({ state, note, go }){
        const course = state.courses.find(c=>c.id===note.courseId);
        /* The API embeds the uploader's name on every note, so the card
           works even before the user record is loaded. */
        const author = state.users.find(u=>u.id===note.userId)
          || (note.uploader ? { id:note.userId, name:note.uploader } : null);
        const r = avgRating(state.ratings, note.id, note);
        /* A photo thumbnail comes from the API file, which needs a login */
        const isPhoto = noteFileKind(note)==="image" && !!state.me;
        return html`<article class="note-card">
          <div class="top">
            <${FileBadge} type=${fileTypeOf(note)} />
            ${course && html`<span class="dept-pill">${course.dept} \u00b7 Semester ${course.sem}</span>`}
          </div>
          ${isPhoto && html`<button type="button" style=${{textAlign:"left",padding:0}} onClick=${()=>go("note", note.id)} aria-label=${"Open "+note.title}>
            <img class="note-card-thumb" src=${fileUrl(note.id, false)} alt=${"Photo of the note \u201c"+note.title+"\u201d"} />
          </button>`}
          <button type="button" style=${{textAlign:"left"}} onClick=${()=>go("note", note.id)}>
            <h3>${note.title}</h3>
          </button>
          ${course && html`<p class="course-line">${course.code} \u00b7 ${course.title}</p>`}
          ${note.desc ? html`<p class="desc">${note.desc}</p>` : null}
          <div class="card-actions">
            <button type="button" class="pb pb-o" onClick=${()=>go("note", note.id)}>Open note</button>
          </div>
          <div class="foot">
            ${author
              ? html`<button type="button" class="uploader" title=${"View "+author.name+"'s profile"} aria-label=${"View profile of "+author.name} onClick=${()=>go("contributor", author.id)}>
                  <${Avatar} user=${author} />
                  <span class="nm">${author.name}</span>
                </button>`
              : html`<span class="uploader">
                  <${Avatar} user=${null} />
                  <span class="nm">Unknown</span>
                </span>`}
            <span style=${{display:"inline-flex",alignItems:"center",gap:"12px"}}>
              <${Stars} avg=${r.avg} count=${r.count} />
              <span class="dl"><${Icon} name="download" size=${16} /> ${note.downloads}</span>
            </span>
          </div>
        </article>`;
      }


            /* ================= Note file (shown directly) =================
         There is no separate preview step: the note page itself holds
         the file. A PDF shows as a PDF inside the page and a photo
         shows as a photo — served straight from the backend API.
         The backend only serves files to logged-in users, so a visitor
         is asked to log in first. */
      function NoteFileViewer({ state, user, note, go }){
        const kind = noteFileKind(note);
        const viewUrl = fileUrl(note.id, false);
        const typeLabel = kind==="image" ? "Photo" : kind==="pdf" ? "PDF" : String(fileTypeOf(note)).toUpperCase()+" file";
        if(!user){
          return html`<div class="file-shell">
            <div class="file-bar">
              <span class="fname">${note.fileName}</span>
              <span>${typeLabel}${note.fileSize ? " · "+fmtSize(note.fileSize) : ""}</span>
            </div>
            <div class="file-msg">
              <${Icon} name="fileText" size=${36} />
              <p>Log in to see the file itself — a PDF shows as a PDF and a photo shows as a photo, right on this page.</p>
              <button class="btn-ink" onClick=${()=>go("login")}>Log in</button>
            </div>
          </div>`;
        }
        return html`<div class="file-shell">
          <div class="file-bar">
            <span class="fname">${note.fileName}</span>
            <span>${typeLabel}${note.fileSize ? " · "+fmtSize(note.fileSize) : ""}</span>
          </div>
          ${kind==="image"
            ? html`<img class="file-img" src=${viewUrl} alt=${"Photo of the note \u201c"+note.title+"\u201d"} />`
            : kind==="pdf"
              ? html`<iframe class="file-frame" src=${viewUrl} title=${note.title+" \u2014 "+note.fileName}></iframe>`
              : html`<div class="file-msg">
                  <${Icon} name="fileText" size=${36} />
                  <p>This note is a ${typeLabel} (${note.fileName}), which a web page cannot display directly. Use Download above to get the file itself.</p>
                </div>`}
        </div>`;
      }


      /* Cascading course picker: dept + semester selects, then hand-typed
         code + title with catalogue suggestions (datalist). The code box
         only auto-capitalises — spaces and other characters are kept
         exactly as typed, and matching stays space-insensitive. */
      function CourseFields({ courses, departments, dept, setDept, sem, setSem, code, setCode, title, setTitle, grid }){
        const deptOptions = departments && departments.length ? departments : DEPARTMENTS;
        const pool = useMemo(()=> courses.filter(c=>c.dept===dept && c.sem===Number(sem)), [courses,dept,sem]);
        const codeListId = useRef("codes-"+Math.random().toString(36).slice(2,8)).current;
        const titleListId = useRef("titles-"+Math.random().toString(36).slice(2,8)).current;
        const onCode = v=>{
          const clean = sanitizeCodeInput(v); setCode(clean);
          const hit = pool.find(c=>normCode(c.code)===normCode(clean));
          if(hit) setTitle(hit.title);
        };
        const onTitle = v=>{
          setTitle(v);
          const hit = pool.find(c=>c.title.toLowerCase()===v.trim().toLowerCase());
          if(hit) setCode(hit.code);
        };
        const deptField = html`<${Field} label="Department">
          <select aria-label="Department" class="in" value=${dept}
            onChange=${e=>{setDept(e.target.value); setSem(""); setCode(""); setTitle("");}}>
            <option value="">Choose a department</option>
            ${deptOptions.map(d=>html`<option key=${d} value=${d}>${d}</option>`)}
          </select>
        </${Field}>`;
        const semField = html`<${Field} label="Semester" hint=${dept ? null : "Choose a department first"}>
          <select aria-label="Semester" class="in" value=${sem} disabled=${!dept}
            onChange=${e=>{setSem(e.target.value); setCode(""); setTitle("");}}>
            <option value="">${dept ? "Choose a semester" : "Choose a department first"}</option>
            ${SEMESTERS.map(s=>html`<option key=${s} value=${s}>Semester ${s}</option>`)}
          </select>
        </${Field}>`;
        const codeField = html`<${Field} label="Course code" hint=${dept && sem ? null : "Choose a semester first"}>
          <input aria-label="Course code" class="in" type="text" list=${codeListId} value=${code} disabled=${!sem}
            placeholder="Example: CSE 1101" autoComplete="off" autoCapitalize="characters" spellCheck="false"
            onInput=${e=>onCode(e.target.value)} />
          <datalist id=${codeListId}>
            ${pool.slice(0,60).map(c=>html`<option key=${c.id} value=${c.code} />`)}
          </datalist>
        </${Field}>`;
        const titleField = html`<${Field} label="Subject title" hint=${sem ? null : "Choose a semester first"}>
          <input aria-label="Subject title" class="in" type="text" list=${titleListId} value=${title} disabled=${!sem}
            placeholder="Example: Introduction to Programming" autoComplete="off"
            onInput=${e=>onTitle(e.target.value)} />
          <datalist id=${titleListId}>
            ${pool.slice(0,60).map(c=>html`<option key=${c.id} value=${c.title} />`)}
          </datalist>
        </${Field}>`;
        if(grid) return html`<div>
          <div class="split2">${deptField}${semField}</div>
          <div class="split2">${codeField}${titleField}</div>
        </div>`;
        return html`<div>${deptField}${semField}${codeField}${titleField}</div>`;
      }

      /* Client-side version of the server rule: a listed code must be used
         with its listed title; an unlisted code+title becomes a new course.
         Matching is space-insensitive, but the code is kept exactly as
         typed (only auto-capitalised). */
      function resolveCourse(state, dept, sem, code, title){
        const clean = cleanCode(code), t = String(title||"").trim();
        if(!dept || !sem) return { error:"Pick a department and a semester first." };
        if(!clean) return { error:"Type the course code." };
        if(!t) return { error:"Type the subject title." };
        const pool = state.courses.filter(c=>c.dept===dept && c.sem===Number(sem));
        const byCode = pool.find(c=>normCode(c.code)===normCode(clean));
        if(byCode){
          if(byCode.title.toLowerCase() !== t.toLowerCase())
            return { error:"Course code "+byCode.code+" is listed as “"+byCode.title+"”. The title does not match — fix the title or use a different code." };
          return { course: byCode, created:false };
        }
        const byTitle = pool.find(c=>c.title.toLowerCase()===t.toLowerCase());
        if(byTitle)
          return { error:"“"+t+"” is already listed with code "+byTitle.code+". Use that code." };
        return { course:{ id: 0, dept, sem:Number(sem), code: clean, title: t }, created:true };
      }

      /* ================= Header & footer ================= */
            /* ================= Header & footer =================
         The original simple header: brand, plain nav links, the account
         menu and the notification bell. No Departments dropdown, no header
         search box, no gold Upload pill, no active-page pill. */
      function Header({ user, state, go, view, act, toast, theme, toggleTheme }){
        const [open,setOpen] = useState(false);
        const [acctOpen,setAcctOpen] = useState(false);
        const [notifOpen,setNotifOpen] = useState(false);
        /* Account / notification panels close on outside click or Escape */
        useEffect(()=>{
          if(!acctOpen && !notifOpen) return;
          const onDoc = e=>{
            if(e.target.closest && e.target.closest("[data-drop]")) return;
            setAcctOpen(false); setNotifOpen(false);
          };
          const onKey = e=>{ if(e.key==="Escape"){ setAcctOpen(false); setNotifOpen(false); } };
          document.addEventListener("mousedown", onDoc);
          document.addEventListener("keydown", onKey);
          return ()=>{ document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
        },[acctOpen,notifOpen]);
        const link = (v,label)=>html`<button key=${v} class="nl" onClick=${()=>{setOpen(false);go(v);}}>${label}</button>`;
        const mlink = (v,label)=>html`<button key=${v} class="mlink" onClick=${()=>{setOpen(false);go(v);}}>${label}</button>`;
        const logout = ()=>{ setOpen(false); setAcctOpen(false); setNotifOpen(false); act.logout(); toast("You have been logged out."); go("home"); };
        const pick = (v,id)=>{ setAcctOpen(false); setNotifOpen(false); setOpen(false); go(v, id); };

        /* Real numbers for the account area, from the signed-in user's own data */
        let stats = null, notifs = [], notifCount = 0, pendingAll = 0, pendingAccounts = 0, waitingAll = 0, latestNotices = [];
        if(user && state){
          const mine = state.myNotes.length ? state.myNotes : state.notes.filter(n=>n.userId===user.id);
          stats = {
            shared: mine.filter(n=>n.status==="approved").length,
            downloads: mine.reduce((s,n)=>s+(n.downloads||0),0),
            bookmarks: state.bookmarks.length
          };
          const pending = (state.adminNotes.length ? state.adminNotes : state.notes).filter(n=>n.status==="pending");
          pendingAll = pending.length;
          pendingAccounts = isAdminUser(user) ? state.pendingUsers.length : 0;
          waitingAll = pendingAll + pendingAccounts;
          latestNotices = [...(state.notices||[])].sort((a,b)=> (b.pinned?1:0)-(a.pinned?1:0) || b.created-a.created).slice(0,3);
          if(isStaffUser(user)){
            notifs = pending.map(n=>{
              const c = state.courses.find(x=>x.id===n.courseId);
              return { key:"n"+n.id, icon:"clock", title:n.title,
                sub:"Waiting for approval · "+(n.uploader||"Unknown")+(c ? " · "+c.code : ""), go:()=>pick("admin") };
            });
            /* Staff also hear about open support tickets */
            const openTickets = (state.adminTickets.length ? state.adminTickets : [])
              .filter(t=>t.status==="open");
            notifs = notifs.concat(openTickets.slice(0,3).map(t=>({ key:"t"+t.id, icon:"user",
              title:t.subject, sub:"Support ticket · "+(t.userName||"a member")+" · "+t.type,
              go:()=>pick("admin", "support") })));
          } else {
            notifs = mine.filter(n=>n.status==="pending").map(n=>({ key:"p"+n.id, icon:"clock",
              title:n.title, sub:"Your note is waiting for admin approval", go:()=>pick("profile") }))
              .concat(mine.filter(n=>n.status==="rejected").map(n=>({ key:"r"+n.id, icon:"x",
                title:n.title, sub:"This note was rejected — open My profile to check it", go:()=>pick("profile") })));
            /* A member hears when staff answered one of their tickets */
            notifs = notifs.concat((state.tickets||[]).filter(t=>t.status==="answered").map(t=>({ key:"ta"+t.id, icon:"check",
              title:t.subject, sub:"Support answered your ticket — open it to read the reply",
              go:()=>pick("support", t.id) })));
          }
          /* Admins also hear about accounts waiting for approval — tapping
             one opens that account's review page (profile + account details). */
          if(isAdminUser(user) && state.pendingUsers.length){
            notifs = state.pendingUsers.map(u=>({ key:"a"+u.id, icon:"user",
              title:u.name, sub:"New account waiting for approval · "+(u.dept||""),
              go:()=>pick("contributor", u.id) })).concat(notifs);
          }
          notifCount = notifs.length;
        }
        const roleLabel = roleLabelOf(user);
        const dropItem = (key, icon, label, action, badge)=>html`<button key=${key} class="drop-item" onClick=${action}>
          <${Icon} name=${icon} size=${18} /><span>${label}</span>
          ${badge ? html`<span class="cnt-badge">${badge}</span>` : null}
          <span class="chev-r"><${Icon} name="chevronR" size=${16} /></span>
        </button>`;
        const statsRow = stats && html`<div class="drop-stats">
          <div class="ds"><b>${stats.shared}</b><span>Notes shared</span></div>
          <div class="ds"><b>${stats.downloads}</b><span>Downloads</span></div>
          <div class="ds"><b>${stats.bookmarks}</b><span>Bookmarks</span></div>
        </div>`;

        return html`<header class="site"><div class="wrap bar">
          <button class="brand" aria-label="Notes Portal home" onClick=${()=>{setOpen(false);go("home");}}>
            <span class="logo-chip"><img src="public/assets/logo.png" alt="City University" /></span>
            <span class="brand-txt"><b>Notes Portal</b><small>University Notes Sharing</small></span>
          </button>
          <nav class="main" aria-label="Main">
            ${link("home","Home")}
            ${link("browse","Notes")}
            ${link("notices","Notices")}
            ${user && link("upload","Upload")}
            ${user && link("profile","My profile")}
            ${user && link("support","Support")}
            ${user && isStaffUser(user) && html`<button key="admin" class="nl" onClick=${()=>{setOpen(false);go("admin");}}>
              ${user.role==="admin" ? "Admin" : "Moderate"}
              ${waitingAll>0 && html`<span class="nav-badge">${waitingAll>9 ? "9+" : waitingAll}</span>`}
            </button>`}
            <span class="nav-actions">
              ${user
                ? html`<span class="notif-wrap" data-drop="notif">
                    <button class="bell-btn" aria-label=${notifCount ? "Notifications, "+notifCount+" waiting" : "Notifications"}
                      aria-expanded=${notifOpen} aria-haspopup="true"
                      onClick=${()=>{ setNotifOpen(!notifOpen); setAcctOpen(false); }}>
                      <${Icon} name="bell" size=${19} />
                      ${notifCount>0 && html`<span class="bell-badge">${notifCount>9 ? "9+" : notifCount}</span>`}
                    </button>
                    ${notifOpen && html`<div class="drop-panel" role="menu" aria-label="Notifications">
                      <p class="drop-sec-t">Notifications</p>
                      ${notifs.length===0
                        ? html`<p class="drop-empty">You're all caught up — nothing is waiting right now.</p>`
                        : html`<div class="drop-items">${notifs.slice(0,5).map(nf=>html`<button key=${nf.key} class="drop-note" onClick=${nf.go}>
                            <${Icon} name=${nf.icon} size=${17} />
                            <span><b>${nf.title}</b><small>${nf.sub}</small></span>
                          </button>`)}
                          ${isStaffUser(user) && waitingAll>0 && html`<button class="drop-item" onClick=${()=>pick("admin")}>
                            <${Icon} name="shield" size=${18} /><span>Open the approval queue</span>
                            <span class="cnt-badge">${waitingAll}</span>
                            <span class="chev-r"><${Icon} name="chevronR" size=${16} /></span>
                          </button>`}
                        </div>`}
                      ${latestNotices.length>0 && html`<p class="drop-sec-t">Latest notices</p>
                        <div class="drop-items">${latestNotices.map(nc=>{
                          const by = state.users.find(u=>u.id===nc.authorId);
                          return html`<button key=${"nc"+nc.id} class="drop-note" onClick=${()=>pick("notices", nc.id)}>
                            <${Icon} name="megaphone" size=${17} />
                            <span><b>${nc.pinned ? "Pinned: " : ""}${nc.important ? "Important: " : ""}${nc.title}</b><small>${fmtDate(nc.created)}${by ? " · by "+by.name : (nc.author ? " · by "+nc.author : "")} — open the notice board</small></span>
                          </button>`;
                        })}</div>`}
                    </div>`}
                  </span>
                  <span class="acct-wrap" data-drop="acct">
                    <button class="acct-btn" aria-expanded=${acctOpen} aria-haspopup="true"
                      aria-label=${"Account menu for "+user.name} onClick=${()=>{ setAcctOpen(!acctOpen); setNotifOpen(false); }}>
                      <${Avatar} user=${user} />
                      <span class="acct-txt"><span class="nm">${user.name}</span><span class="sub">${roleLabel} · ${user.dept}</span></span>
                      <span class="chev"><${Icon} name="chevronD" size=${16} /></span>
                    </button>
                    ${acctOpen && html`<div class="drop-panel" role="menu" aria-label="Account menu">
                      <div class="drop-head">
                        <${Avatar} user=${user} />
                        <div>
                          <p class="nm">${user.name}</p>
                          <p class="em">${user.email}</p>
                          <span class="drop-badges">
                            <span class=${"badge-role "+user.role}>${roleLabel}</span>
                            <span class="dept-pill">${user.dept}</span>
                            ${user.suspended && html`<span class="badge-suspended">Suspended</span>`}
                          </span>
                        </div>
                        <${ThemeButton} theme=${theme} onToggle=${toggleTheme} />
                      </div>
                      ${statsRow}
                      <div class="drop-items">
                        ${dropItem("profile","user","My profile",()=>pick("profile"))}
                        ${dropItem("public","eye","View my public profile",()=>pick("contributor", user.id))}
                        ${dropItem("upload","upload","Upload a note",()=>pick("upload"))}
                        ${dropItem("bookmarks","bookmark","My bookmarks",()=>pick("profile"), stats.bookmarks || null)}
                        ${dropItem("notices","megaphone","Notice board",()=>pick("notices"))}
                        ${dropItem("support","user","Support",()=>pick("support"))}
                        ${isStaffUser(user) && dropItem("admin","shield", user.role==="admin" ? "Admin panel" : "Moderator panel",()=>pick("admin"), waitingAll || null)}
                      </div>
                      <div class="drop-foot">
                        <button class="drop-item" onClick=${logout}>
                          <${Icon} name="logout" size=${18} /><span>Log out</span>
                        </button>
                      </div>
                    </div>`}
                  </span>`
                : html`<button class="btn-ghost" onClick=${()=>go("login")}>Log in</button>
                  <button class="btn-gold" onClick=${()=>go("register")}>Get started</button>`}
            </span>
          </nav>
          <button class="menu-btn" aria-label=${open ? "Close menu" : "Open menu"} aria-expanded=${open}
            onClick=${()=>setOpen(!open)}>
            <${Icon} name=${open ? "x" : "menu"} size=${20} />
          </button>
        </div>
        ${open && html`<nav class="mobile" aria-label="Menu">
          ${user && html`<div class="m-acct">
            <div class="row1">
              <${Avatar} user=${user} cls="avatar lg" />
              <div>
                <p class="nm">${user.name}</p>
                <p class="em">${user.email}</p>
                <span class="drop-badges">
                  <span class=${"badge-role "+user.role}>${roleLabel}</span>
                  <span class="dept-pill">${user.dept}</span>
                </span>
              </div>
              <${ThemeButton} theme=${theme} onToggle=${toggleTheme} />
            </div>
            ${statsRow}
            ${notifCount>0 && html`<button class="pend-line" onClick=${()=>pick(isStaffUser(user) ? "admin" : "profile")}>
              <${Icon} name="bell" size=${16} />
              <span>${isStaffUser(user)
                ? (pendingAll>0 ? pendingAll+" note"+(pendingAll===1?"":"s") : "") + (pendingAll>0 && pendingAccounts>0 ? " · " : "") + (pendingAccounts>0 ? pendingAccounts+" new account"+(pendingAccounts===1?"":"s") : "") + " waiting for your approval"
                : notifCount+" of your notes need attention"}</span>
            </button>`}
            <div class="quick">
              <button class="pb pb-o" onClick=${()=>pick("contributor", user.id)}><${Icon} name="eye" size=${15} /> Public profile</button>
              <button class="pb pb-o" onClick=${()=>pick("upload")}><${Icon} name="upload" size=${15} /> Upload note</button>
            </div>
          </div>`}
          ${mlink("home","Home")}
          ${mlink("browse","Notes")}
          ${mlink("notices","Notices")}
          ${user && mlink("upload","Upload")}
          ${user && mlink("profile","My profile")}
          ${user && mlink("support","Support")}
          ${user && isStaffUser(user) && mlink("admin", user.role==="admin" ? "Admin" : "Moderate")}
          <div class="m-actions">
            ${user
              ? html`<button class="btn-ghost" style=${{width:"100%"}} onClick=${logout}>
                  <${Icon} name="logout" size=${16} /> Log out
                </button>`
              : html`<button class="btn-ghost" style=${{width:"100%"}} onClick=${()=>{setOpen(false);go("login");}}>Log in</button>
                <button class="btn-gold" style=${{width:"100%"}} onClick=${()=>{setOpen(false);go("register");}}>Get started</button>`}
          </div>
        </nav>`}
        </header>`;
      }



      function Footer({ user, go }){
        const flink = (v,label)=>html`<button key=${label} class="foot-link" onClick=${()=>go(v)}>${label}</button>`;
        return html`<footer class="site"><div class="wrap">
          <div class="foot-grid">
            <div>
              <span class="logo-chip"><img src="public/assets/logo.png" alt="City University" /></span>
              <p class="foot-desc">University Notes Sharing Portal. Upload, search and download study notes in one trusted place.</p>
            </div>
            <div>
              <h4>Portal</h4>
              ${flink("home","Home")}
              ${flink("browse","Notes")}
              ${flink("notices","Notices")}
              ${flink("register","Create account")}
              ${user && flink("upload","Upload a note")}
              ${user && flink("support","Support")}
            </div>
            <div>
              <h4>Project team</h4>
              ${["Md Asif Hossain","Jobyda Akter Jhoty","Purnima Maria Palma","Sadia Afrin Ifti"].map(m=>
                html`<span key=${m} class="foot-team">${m}</span>`)}
            </div>
          </div>
          <div class="foot-bottom">
            <span>© 2026 University Notes Sharing Portal · City University</span>
            <button class="top-btn" onClick=${()=>window.scrollTo({top:0,behavior:"smooth"})}>Back to top ↑</button>
          </div>
        </div></footer>`;
      }

      /* ================= Home ================= */
      function Home({ state, go }){
        const [q,setQ] = useState("");
        const notices = [...(state.notices||[])].sort((a,b)=> (b.pinned?1:0)-(a.pinned?1:0) || b.created-a.created);
        const approved = state.notes.filter(n=>n.status==="approved");
        const latest = [...approved].sort((a,b)=>b.created-a.created).slice(0,6);
        const sqlNote = state.notes.find(n=>n.id===13);
        const sqlR = sqlNote ? avgRating(state.ratings, sqlNote.id, sqlNote) : { avg:0, count:0 };
        const miniRows = [13,11].map(id=>state.notes.find(n=>n.id===id)).filter(Boolean).map(n=>{
          const r = avgRating(state.ratings, n.id, n);
          return { note:n, label: r.avg.toFixed(1)+" ★ · "+n.downloads+" downloads" };
        });
        const submit = e=>{ e.preventDefault(); go("browse", null, q); };
        const checkItem = (text, dark)=>html`<li key=${text}>
          <span class=${"check-dot"+(dark ? " on-dark" : "")}><${Icon} name="check" size=${12} sw=${3.5} /></span>${text}
        </li>`;
        return html`<div class="view">
          <section class="hero-sec"><div class="wrap"><div class="hero-grid">
            <div>
              <p class="kicker"><span class="dot"></span>City University · Student Notes Library</p>
              <h1 class="hero-h1">Study smarter with notes <span class="headline-em">shared by your classmates.</span></h1>
              <p class="lede">Upload, search and download lecture notes, assignment solutions and previous exam questions, organized by department, semester and course.</p>
              <form class="hero-search" role="search" onSubmit=${submit}>
                <${Icon} name="search" size=${20} />
                <input type="search" aria-label="Search notes" placeholder="Search notes, courses or keywords"
                  value=${q} onInput=${e=>setQ(e.target.value)} />
                <button class="btn-ink" type="submit">Search</button>
              </form>
              <p class="popular">Popular:
                ${["Data Structures","Database Systems","Electronic Circuit"].map(term=>
                  html`<button key=${term} class="chip" onClick=${()=>go("browse", null, term)}>${term}</button>`)}
              </p>
              <ul class="checks">
                ${["Files open right on the page","Rated by students","Checked by admins"].map(t=>checkItem(t,false))}
              </ul>
            </div>
            <div class="hero-photo">
              <div class="arch">
                <img src="public/assets/hero.jpg" alt="City University academic building with a flower garden in front" />
              </div>
              ${state.me
                ? html`<div class="float-card fc1 float-bob">
                    <${FileBadge} type="pdf" />
                    <div>
                      <b>SQL Joins Cheat Sheet</b>
                      <small>CSE 2105 · Semester 3</small>
                      <${Stars} avg=${sqlR.avg} count=${sqlR.count} />
                    </div>
                  </div>
                  <div class="float-card fc2 float-bob-late">
                    <span class="check-circle"><${Icon} name="check" size=${18} sw=${3} /></span>
                    <div>
                      <b>Note approved</b>
                      <small>Process Scheduling Algorithms</small>
                    </div>
                  </div>`
                : html`<div class="float-card fc1 float-bob">
                    <${FileBadge} type="pdf" />
                    <div>
                      <b>Notes shared by classmates</b>
                      <small>Log in to open them</small>
                    </div>
                  </div>
                  <div class="float-card fc2 float-bob-late">
                    <span class="check-circle"><${Icon} name="check" size=${18} sw=${3} /></span>
                    <div>
                      <b>Checked by admins</b>
                      <small>Every note is reviewed first</small>
                    </div>
                  </div>`}
            </div>
          </div></div></section>

          <section class="marquee-sec" aria-label="Departments">
            <div class="marquee-track">
              ${[0,1].map(dup=>html`<span key=${dup} class="grp" aria-hidden=${dup===1}>
                ${deptList(state).map(d=>html`<span key=${d} class="dept">${d} <span class="spark">✦</span></span>`)}
              </span>`)}
            </div>
          </section>

          <section class="notice-sec" id="notice-board" aria-label="Notice board"><div class="wrap">
            <div class="notice-head">
              <div>
                <p class="kicker plain">Notice board</p>
                <h2>Announcements from the admins</h2>
              </div>
              <span style=${{fontSize:"14px",color:"var(--dim)"}}>${notices.length} ${notices.length===1 ? "notice" : "notices"}</span>
            </div>
            ${notices.length===0
              ? html`<p class="notice-empty">No notices right now. Admin announcements will appear here.</p>`
              : html`<div class="notice-list">
                  ${notices.map(nc=>{
                    const by = state.users.find(u=>u.id===nc.authorId);
                    return html`<article key=${nc.id} class=${"notice-card"+(nc.pinned ? " pinned" : "")}>
                      <div class="nc-top">
                        ${nc.pinned && html`<span class="badge-pinned"><${Icon} name="pin" size=${13} /> Pinned</span>`}
                        ${nc.important && html`<span class="badge-important">Important</span>`}
                        <span class="nc-date">${fmtDate(nc.created)}</span>
                        ${by && html`<span class="nc-by">by ${by.name} · ${roleLabelOf(by)}</span>`}
                      </div>
                      <h3>${nc.title}</h3>
                      <p>${nc.body}</p>
                    </article>`;
                  })}
                </div>`}
          </div></section>

          <section class="sec"><div class="wrap">
            <div class="sec-head">
              <p class="kicker plain">Features</p>
              <h2>Everything you need to find, share and trust good notes.</h2>
              <p class="sub">One organized place instead of scattered phones, group chats and expired links.</p>
            </div>
            <div class="feat-grid">
              <article class="feat grad wide">
                <span class="feat-icon"><${Icon} name="search" size=${24} /></span>
                <h3>Search that finds the right note</h3>
                <p>Filter by department, semester, course or keyword and get to the exact lecture notes in seconds.</p>
                <div class="mini">
                  <div class="chips">
                    <span class="chip-ink">CSE</span>
                    <span class="chip-ink">Semester 3</span>
                    <span class="chip-o">Database Systems</span>
                  </div>
                  ${miniRows.map(({note,label})=>html`<div class="row" key=${note.id}>
                    <${FileBadge} type=${fileTypeOf(note)} />
                    <div><b>${note.title}</b><small>${label}</small></div>
                  </div>`)}
                </div>
              </article>
              <article class="feat dark">
                <span class="feat-icon"><${Icon} name="upload" size=${24} /></span>
                <h3>Upload in seconds</h3>
                <p>PDF, DOC, PPT and images up to 10 MB, with a title, course and description.</p>
              </article>
              ${[
                { icon:"eye", title:"The file itself, on the page", body:"Open a note and its file is right there — a PDF shows as a PDF and a photo shows as a photo. Download only what helps." },
                { icon:"star", title:"Ratings and comments", body:"Rate notes from 1 to 5 and discuss them, so quality rises to the top." },
                { icon:"bookmark", title:"Personal bookmarks", body:"Save your favorite notes to your profile and find them again fast." }
              ].map(t=>html`<article class="feat" key=${t.title}>
                <span class="feat-icon"><${Icon} name=${t.icon} size=${24} /></span>
                <h3>${t.title}</h3>
                <p>${t.body}</p>
              </article>`)}
              <article class="feat trust">
                <div class="txt">
                  <span class="feat-icon"><${Icon} name="shield" size=${24} /></span>
                  <h3>Quality you can trust</h3>
                  <p>Admins approve or reject every upload, manage users and categories, and remove inappropriate content, so the library stays clean and useful.</p>
                </div>
                <ol class="steps-pill">
                  ${["Student uploads","Admin reviews","Note goes live"].map((s,i)=>
                    html`<li key=${s}><span class="n">${i+1}</span>${s}</li>`)}
                </ol>
              </article>
            </div>
          </div></section>

          <section class="dark-sec"><div class="wrap">
            <p class="kicker plain">How it works</p>
            <h2>From sign up to a better grade, in four simple steps.</h2>
            <ol class="how-grid">
              ${[
                { n:"01", t:"Create your account", b:"Sign up with your university email and set up your profile in a minute." },
                { n:"02", t:"Upload or explore notes", b:"Share your own notes, or search the Notes library by department, semester and course." },
                { n:"03", t:"Open and download", b:"Open the note, see its file right on the page, then download what you actually need." },
                { n:"04", t:"Rate and bookmark", b:"Leave a rating or comment and save the best notes for later." }
              ].map(s=>html`<li key=${s.n}>
                <span class="how-num">${s.n}</span>
                <h3>${s.t}</h3>
                <p>${s.b}</p>
              </li>`)}
            </ol>
          </div></section>

          <section class="sec"><div class="wrap">
            <div class="lib-head">
              <div>
                <p class="kicker plain">The library</p>
                <h2>Fresh from the community.</h2>
              </div>
              <button class="btn-ghost" onClick=${()=>go("browse")}>All notes <${Icon} name="chevronR" size=${18} /></button>
            </div>
            ${!state.me
              ? html`<${EmptyState} title="Log in to see the notes" body="The library opens after you log in — browse the notice board above while you are here.">
                  <div class="cta"><button class="btn-gold" onClick=${()=>go("login")}>Log in</button>
                  <button class="btn-ghost" onClick=${()=>go("register")}>Create an account</button></div>
                </${EmptyState}>`
              : latest.length===0
              ? html`<${EmptyState} title="No notes yet" body="The library is empty right now. Check back soon, or be the first to upload." />`
              : html`<div class="grid3">${latest.map(n=>html`<${NoteCard} key=${n.id} state=${state} note=${n} go=${go} />`)}</div>`}
          </div></section>

          <div class="wrap"><div class="aud-grid">
            <div class="aud">
              <p class="kicker plain">For students</p>
              <h3>Learn from the best notes in your batch.</h3>
              <ul>
                ${["Search by department, semester, course or keyword","Open and download notes, slides and exam questions","Rate, comment and bookmark your favorites","Upload your own notes and help your juniors"].map(t=>checkItem(t,false))}
              </ul>
              <button class="btn-ink" onClick=${()=>go("register")}>Join as a student</button>
            </div>
            <div class="aud dark">
              <p class="kicker plain" style=${{color:"var(--gold-bright)"}}>For admins</p>
              <h3>Keep the library clean and reliable.</h3>
              <ul>
                ${["Approve or reject uploaded notes","Post notices for every student","Make members admin or moderator, or suspend an account","Remove inappropriate content"].map(t=>checkItem(t,true))}
              </ul>
              <button class="btn-gold" onClick=${()=>go("login")}>Admin login</button>
            </div>
          </div></div>

          <section class="campus-sec"><div class="wrap">
            <div class="campus-grid">
              <div class="gate">
                <img src="public/assets/gate.jpg" alt="The main gate of City University, Khagan, Dhaka" />
              </div>
              <div class="campus-txt">
                <p class="kicker plain">Made for City University</p>
                <h2>A shared library, built by students, for students.</h2>
                <p class="body">Great notes already exist on every campus. They just live in different places. The Notes Portal brings them together so every City University student can learn from the best of what their classmates have written.</p>
                <p class="loc"><span class="rd">●</span> Khagan, Birulia, Savar, Dhaka</p>
              </div>
            </div>
            <figure class="pano" style=${{margin:"56px 0 0"}}>
              <img src="public/assets/pano.jpg" alt="Panoramic view of the City University campus with green lawns and academic buildings" />
              <span class="shade"></span>
              <figcaption>The City University campus</figcaption>
            </figure>
          </div></section>

          <section class="cta-sec"><div class="wrap">
            <div class="cta">
              <h2>Share what you know. <span class="it">Learn from everyone.</span></h2>
              <p>Join the portal and make this semester your best one yet.</p>
              <div class="row">
                <button class="btn-gold btn-lg" onClick=${()=>go("register")}>Create free account</button>
                <button class="btn-outline-w" onClick=${()=>go("browse")}>Notes</button>
              </div>
            </div>
          </div></section>
        </div>`;
      }

      /* ================= Important-notice banner =================
         An important notice shows under the header on every page for a
         logged-in member, until they dismiss it (saved per member). */
      function ImportantNoticeBanner({ state, act, toast }){
        const user = state.me;
        if(!user) return null;
        const imp = (state.notices||[]).filter(n=>n.important && !n.dismissed)
          .sort((a,b)=>b.created-a.created)[0];
        if(!imp) return null;
        return html`<div class="important-banner" role="status">
          <span class="ib-icon"><${Icon} name="megaphone" size=${20} /></span>
          <div class="ib-body">
            <p class="ib-tag">Important notice</p>
            <p class="ib-title">${imp.title}</p>
            <p class="ib-text">${imp.body}</p>
            <p class="ib-meta">${fmtDate(imp.created)}${imp.author ? " · by "+imp.author : ""}</p>
          </div>
          <button class="ib-x" aria-label="Dismiss this notice" title="Dismiss"
            onClick=${async ()=>{ const r = await act.dismissNotice(imp.id); if(!r.ok) toast(r.error); }}>
            <${Icon} name="x" size=${18} />
          </button>
        </div>`;
      }

      /* ================= Notice board (dedicated page) =================
         The bell, the account menu and the footer all land here. When a
         notice is opened from the bell, it scrolls into view with a gold
         outline so the member finds it at once. */
      function NoticeBoard({ state, go, focusId }){
        const notices = [...(state.notices||[])].sort((a,b)=> (b.pinned?1:0)-(a.pinned?1:0) || b.created-a.created);
        useEffect(()=>{
          if(!focusId) return;
          const t = setTimeout(()=>{
            const el = document.getElementById("notice-"+focusId);
            if(el) el.scrollIntoView({ behavior:"smooth", block:"center" });
          }, 80);
          return ()=>clearTimeout(t);
        },[focusId]);
        return html`<div class="view"><div class="wrap"><div class="page">
          <div class="page-head">
            <h1>Notice board</h1>
            <p>Announcements from the admins — pinned notices first, then the newest.</p>
          </div>
          ${notices.length===0
            ? html`<${EmptyState} title="No notices yet" body="Admin announcements will appear here." />`
            : html`<div class="notice-list">
                ${notices.map(nc=>{
                  const by = state.users.find(u=>u.id===nc.authorId);
                  return html`<article key=${nc.id} id=${"notice-"+nc.id} class=${"notice-card"+(nc.pinned ? " pinned" : "")+(nc.id===focusId ? " notice-focus" : "")}>
                    <div class="nc-top">
                      ${nc.pinned && html`<span class="badge-pinned"><${Icon} name="pin" size=${13} /> Pinned</span>`}
                      ${nc.important && html`<span class="badge-important">Important</span>`}
                      <span class="nc-date">${fmtDate(nc.created)}</span>
                      ${by && html`<span class="nc-by">by ${by.name} · ${roleLabelOf(by)}</span>`}
                      ${!by && nc.author && html`<span class="nc-by">by ${nc.author}</span>`}
                    </div>
                    <h3>${nc.title}</h3>
                    <p>${nc.body}</p>
                  </article>`;
                })}
              </div>`}
        </div></div></div>`;
      }

      /* ================= Support =================
         A logged-in member opens a ticket (problem type + subject +
         details); staff answer from the Admin panel. The member sees the
         reply thread here, can reply back, and can close or re-open it. */
      const SUPPORT_TYPES = ["Login/Account","Upload","Download/File","Note approval","Report","Other"];
      function Support({ state, user, go, act, toast, ticketId }){
        const [type,setType] = useState("Login/Account");
        const [subject,setSubject] = useState("");
        const [details,setDetails] = useState("");
        const [msg,setMsg] = useState(null);
        const [busy,setBusy] = useState(false);
        const [thread,setThread] = useState(null);
        const [reply,setReply] = useState("");
        const [loading,setLoading] = useState(false);
        useEffect(()=>{ if(user) act.loadTickets(); },[user && user.id]);
        useEffect(()=>{
          let on = true;
          if(!ticketId){ setThread(null); return; }
          setLoading(true);
          act.loadTicket(ticketId).then(r=>{ if(on){ if(r.ok) setThread(r.data); else toast(r.error); setLoading(false); } });
          return ()=>{ on = false; };
        },[ticketId]);
        if(!user) return html`<div class="view"><div class="wrap"><div class="page">
          <${EmptyState} title="Log in to contact support" body="You need an account to ask the admins or moderators for help.">
            <div class="cta"><button class="btn-gold" onClick=${()=>go("login")}>Log in</button></div>
          </${EmptyState}>
        </div></div></div>`;
        const tickets = [...(state.tickets||[])].sort((a,b)=>b.updated-a.updated);
        const submit = async e=>{
          e.preventDefault(); setMsg(null);
          if(!subject.trim()){ setMsg({kind:"error",text:"Please write a subject for your problem."}); return; }
          if(!details.trim()){ setMsg({kind:"error",text:"Please describe the problem."}); return; }
          setBusy(true);
          const r = await act.addTicket({ type, subject:subject.trim(), details:details.trim() });
          setBusy(false);
          if(!r.ok){ setMsg({kind:"error",text:r.error}); return; }
          setSubject(""); setDetails("");
          setMsg({kind:"success",text:"Your ticket was sent. An admin or moderator will reply here."});
        };
        const sendReply = async e=>{
          e.preventDefault();
          if(!reply.trim()) return;
          setBusy(true);
          const r = await act.addTicketReply(thread.ticket.id, reply.trim());
          setBusy(false);
          if(!r.ok){ toast(r.error); return; }
          setReply("");
          const d = await act.loadTicket(thread.ticket.id);
          if(d.ok) setThread(d.data);
        };
        const doClose = async ()=>{
          const r = await act.closeTicket(thread.ticket.id);
          if(!r.ok){ toast(r.error); return; }
          const d = await act.loadTicket(thread.ticket.id);
          if(d.ok) setThread(d.data);
        };
        const doReopen = async ()=>{
          const r = await act.reopenTicket(thread.ticket.id);
          if(!r.ok){ toast(r.error); return; }
          const d = await act.loadTicket(thread.ticket.id);
          if(d.ok) setThread(d.data);
        };
        const statusLabel = s => s==="open" ? "Open" : s==="answered" ? "Answered" : "Closed";
        return html`<div class="view"><div class="wrap"><div class="page">
          <div class="page-head">
            <h1>Support</h1>
            <p>Having a problem? Tell the admins or moderators — they will reply to your ticket here.</p>
          </div>
          ${thread
            ? html`<div>
                <button class="back-link" onClick=${()=>go("support")}>← Back to my tickets</button>
                ${loading
                  ? html`<p style=${{color:"var(--dim)"}}>Loading the ticket…</p>`
                  : html`<section class="card p8">
                      <div style=${{display:"flex",flexWrap:"wrap",alignItems:"center",gap:"10px"}}>
                        <h2 class="sec-h2" style=${{margin:0,flex:"1 1 240px"}}>${thread.ticket.subject}</h2>
                        <span class=${"badge-status "+thread.ticket.status}>${statusLabel(thread.ticket.status)}</span>
                      </div>
                      <p style=${{color:"var(--dim)",fontSize:"14px",margin:"8px 0 0"}}>${thread.ticket.type} · opened ${fmtDate(thread.ticket.created)}</p>
                      <p style=${{margin:"16px 0 0",whiteSpace:"pre-wrap"}}>${thread.ticket.details}</p>
                      <div class="ticket-thread">
                        ${thread.replies.map(rp=>html`<div class="comment-row" key=${rp.id}>
                          <${Avatar} user=${rp} />
                          <div style=${{minWidth:0}}>
                            <span class="nm">${rp.name}</span>
                            <span class="dt">${fmtDate(rp.created)}${(rp.role==="admin" || rp.role==="moderator") ? " · staff" : ""}</span>
                            <p class="tx">${rp.body}</p>
                          </div>
                        </div>`)}
                      </div>
                      ${thread.ticket.status!=="closed"
                        ? html`<form onSubmit=${sendReply} style=${{marginTop:"16px"}}>
                            <label class="sr" htmlFor="ticket-reply">Write a reply</label>
                            <textarea id="ticket-reply" class="in" rows="3" required maxLength="5000"
                              placeholder="Write your reply…" value=${reply}
                              onInput=${e=>setReply(e.target.value)}></textarea>
                            <div style=${{marginTop:"12px",display:"flex",flexWrap:"wrap",gap:"10px"}}>
                              <button class="btn-ink" type="submit" disabled=${busy || !reply.trim()}>Send reply</button>
                              <button class="btn-ghost" type="button" disabled=${busy} onClick=${doClose}>Close ticket</button>
                            </div>
                          </form>`
                        : html`<div style=${{marginTop:"16px",display:"flex",flexWrap:"wrap",gap:"10px",alignItems:"center"}}>
                            <p style=${{color:"var(--dim)",margin:0}}>This ticket is closed.</p>
                            <button class="btn-ghost" type="button" disabled=${busy} onClick=${doReopen}>Re-open ticket</button>
                          </div>`}
                    </section>`}
              </div>`
            : html`<div class="support-grid">
                <section class="card p8">
                  <h2 class="sec-h2">Open a ticket</h2>
                  ${msg && html`<${AlertBox} kind=${msg.kind}>${msg.text}</${AlertBox}>`}
                  <form onSubmit=${submit}>
                    <${Field} label="What is the problem about?">
                      <select aria-label="Problem type" class="in" value=${type} onChange=${e=>setType(e.target.value)}>
                        ${SUPPORT_TYPES.map(t=>html`<option key=${t} value=${t}>${t}</option>`)}
                      </select>
                    </${Field}>
                    <${Field} label="Subject">
                      <input aria-label="Subject" class="in" type="text" required maxLength="150"
                        placeholder="Example: I cannot download my note" value=${subject}
                        onInput=${e=>setSubject(e.target.value)} />
                    </${Field}>
                    <${Field} label="Details">
                      <textarea aria-label="Details" class="in" rows="5" required maxLength="5000"
                        placeholder="Describe the problem — what happened, and where?" value=${details}
                        onInput=${e=>setDetails(e.target.value)}></textarea>
                    </${Field}>
                    <button class="btn-gold" type="submit" disabled=${busy}>${busy ? "Sending…" : "Send ticket"}</button>
                  </form>
                </section>
                <section class="card p8">
                  <h2 class="sec-h2">My tickets (${tickets.length})</h2>
                  ${tickets.length===0
                    ? html`<p style=${{color:"var(--dim)",margin:0}}>No tickets yet. Open one with the form and staff will reply here.</p>`
                    : html`<ul class="rows">
                        ${tickets.map(t=>html`<li class="row-item" key=${t.id}>
                          <span class="file-badge" aria-hidden="true"><${Icon} name="user" size=${18} /></span>
                          <button class="row-main" onClick=${()=>go("support", t.id)}>
                            <b>${t.subject}</b>
                            <small>${t.type} · ${fmtDate(t.created)} · ${t.replyCount} ${t.replyCount===1 ? "reply" : "replies"}</small>
                          </button>
                          <span class=${"badge-status "+t.status}>${statusLabel(t.status)}</span>
                        </li>`)}
                      </ul>`}
                </section>
              </div>`}
        </div></div></div>`;
      }

      /* ================= Browse ================= */
      const PAGE_STEP = 9;
      function Browse({ state, go, initQ, initDept }){
        const [q,setQ] = useState(initQ||"");
        const [dept,setDept] = useState(initDept||"");
        const [sem,setSem] = useState("");
        const [courseId,setCourseId] = useState("");
        const [sort,setSort] = useState("newest");
        const [shown,setShown] = useState(PAGE_STEP);
        const dq = useDebounced(q, 220); // debounced keyword search — no per-keystroke filtering cost
        useEffect(()=>{ setShown(PAGE_STEP); },[dq,dept,sem,courseId,sort]);

        const semesters = useMemo(()=>{
          const pool = state.courses.filter(c=>!dept || c.dept===dept);
          return [...new Set(pool.map(c=>c.sem))].sort((a,b)=>a-b);
        },[state.courses,dept]);
        const courseOptions = useMemo(()=> state.courses
          .filter(c=>(!dept || c.dept===dept) && (!sem || c.sem===Number(sem)))
          .sort((a,b)=> a.dept.localeCompare(b.dept) || a.sem-b.sem || a.code.localeCompare(b.code)),
          [state.courses,dept,sem]);

        const results = useMemo(()=>{
          const needle = dq.trim().toLowerCase();
          const list = state.notes.filter(n=>n.status==="approved").filter(n=>{
            const c = state.courses.find(cc=>cc.id===n.courseId);
            if(!c) return false;
            if(dept && c.dept!==dept) return false;
            if(sem && c.sem!==Number(sem)) return false;
            if(courseId && c.id!==Number(courseId)) return false;
            if(needle){
              const hay = (n.title+" "+n.desc+" "+c.code+" "+c.title+" "+c.dept).toLowerCase();
              if(!hay.includes(needle)) return false;
            }
            return true;
          });
          if(sort==="rated") list.sort((a,b)=> avgRating(state.ratings,b.id,b).avg - avgRating(state.ratings,a.id,a).avg || b.created-a.created);
          else if(sort==="downloads") list.sort((a,b)=> b.downloads-a.downloads);
          else if(sort==="title") list.sort((a,b)=> a.title.localeCompare(b.title));
          else list.sort((a,b)=> b.created-a.created);
          return list;
        },[state,dq,dept,sem,courseId,sort]);

        const clear = ()=>{ setQ(""); setDept(""); setSem(""); setCourseId(""); setSort("newest"); };
        const courseLabel = (dept || sem)
          ? "All courses"+(dept ? " in "+dept : "")+(sem ? " · Semester "+sem : "")+" ("+courseOptions.length+")"
          : "All courses";

        /* Notes are for logged-in members only — the catalogue and the
           notice board stay public, the library does not. */
        if(!state.me) return html`<div class="view"><div class="wrap"><div class="page">
          <div class="page-head">
            <h1>Notes</h1>
            <p>Search by keyword, or filter by department, semester, or course. Open any note and its file — PDF or photo — is right there on the page.</p>
          </div>
          <${EmptyState} title="Log in to see the notes" body="The library opens after you log in — browse the notice board while you are here.">
            <div class="cta"><button class="btn-gold" onClick=${()=>go("login")}>Log in</button>
            <button class="btn-ghost" onClick=${()=>go("register")}>Create an account</button></div>
          </${EmptyState}>
        </div></div></div>`;

        return html`<div class="view"><div class="wrap"><div class="page">
          <div class="page-head">
            <h1>Notes</h1>
            <p>Search by keyword, or filter by department, semester, or course. Open any note and its file — PDF or photo — is right there on the page.</p>
          </div>
          <form class="filter-card" role="search" onSubmit=${e=>e.preventDefault()}>
            <input type="search" aria-label="Search" class="in" placeholder="Search title, course or keyword"
              value=${q} onInput=${e=>setQ(e.target.value)} />
            <select aria-label="Department" class="in" value=${dept}
              onChange=${e=>{setDept(e.target.value); setCourseId("");}}>
              <option value="">All departments</option>
              ${deptList(state).map(d=>html`<option key=${d} value=${d}>${d}</option>`)}
            </select>
            <select aria-label="Semester" class="in" value=${sem}
              onChange=${e=>{setSem(e.target.value); setCourseId("");}}>
              <option value="">${dept ? "All semesters in "+dept : "All semesters"}</option>
              ${semesters.map(s=>html`<option key=${s} value=${s}>Semester ${s}</option>`)}
            </select>
            <select aria-label="Course" class="in" value=${courseId} onChange=${e=>setCourseId(e.target.value)}>
              <option value="">${courseLabel}</option>
              ${courseOptions.slice(0,300).map(c=>html`<option key=${c.id} value=${c.id}>${c.code} — ${c.title}</option>`)}
            </select>
            <select aria-label="Sort by" class="in" value=${sort} onChange=${e=>setSort(e.target.value)}>
              <option value="newest">Newest first</option>
              <option value="rated">Top rated</option>
              <option value="downloads">Most downloaded</option>
              <option value="title">Title A–Z</option>
            </select>
            <button type="button" class="btn-ghost" onClick=${clear}>Clear</button>
          </form>

          <p class="count-line" role="status">${results.length} ${results.length===1 ? "note" : "notes"} found</p>
          ${results.length===0
            ? html`<${EmptyState} title="No notes match your search" body="Try a different keyword, or clear the filters to see the whole library." />`
            : html`<div class="grid3 browse-grid" key=${dq+"|"+dept+"|"+sem+"|"+courseId+"|"+sort+"|"+shown}>${results.slice(0,shown).map(n=>html`<${NoteCard} key=${n.id} state=${state} note=${n} go=${go} />`)}</div>`}
          ${shown < results.length && html`<div class="show-more">
            <button class="btn-ghost" onClick=${()=>setShown(shown+PAGE_STEP)}>Show more notes (${results.length-shown} remaining)</button>
          </div>`}

        </div></div></div>`;
      }

      /* ================= Note detail ================= */
            function NoteDetail({ state, user, noteId, go, act, toast }){
        const note = state.notes.find(n=>n.id===noteId)
          || state.myNotes.find(n=>n.id===noteId)
          || state.adminNotes.find(n=>n.id===noteId);
        const [commentText,setCommentText] = useState("");
        const [confirmDel,setConfirmDel] = useState(false);
        const [detailLoading,setDetailLoading] = useState(!note);
        /* Comments, my rating and bookmark state come from the API */
        useEffect(()=>{
          let on = true;
          if(!user){ setDetailLoading(false); return; }
          setDetailLoading(true);
          act.loadNoteDetail(noteId).finally(()=>{ if(on) setDetailLoading(false); });
          return ()=>{ on = false; };
        },[noteId]);
        /* A note page is for logged-in members only. */
        if(!user) return html`<div class="view"><div class="wrap"><div class="page">
          <${EmptyState} title="Log in to open this note" body="Notes open after you log in — browse the notice board while you are here.">
            <div class="cta"><button class="btn-gold" onClick=${()=>go("login")}>Log in</button>
            <button class="btn-ghost" onClick=${()=>go("register")}>Create an account</button></div>
          </${EmptyState}>
        </div></div></div>`;
        if(!note && detailLoading) return html`<div class="view"><div class="wrap"><div class="page">
          <p style=${{color:"var(--dim)"}}>Loading the note…</p>
        </div></div></div>`;
        if(!note) return html`<div class="view"><div class="wrap"><div class="page">
          <${EmptyState} title="Note not found" body="This note does not exist, or it is still waiting for approval and is not yours to see.">
            <div class="cta"><button class="btn-ink" onClick=${()=>go("browse")}>Notes</button></div>
          </${EmptyState}>
        </div></div></div>`;
        const course = state.courses.find(c=>c.id===note.courseId);
        const author = state.users.find(u=>u.id===note.userId)
          || (note.uploader ? { id:note.userId, name:note.uploader } : null);
        const r = avgRating(state.ratings, note.id, note);
        const myRating = user ? (state.myRatings[note.id] || 0) : 0;
        const bookmarked = user ? state.bookmarks.some(b=>b.noteId===note.id) : false;
        const comments = state.comments.filter(c=>c.noteId===note.id).sort((a,b)=>a.created-b.created);
        const approved = note.status==="approved";
        const ownNote = !!user && user.id===note.userId;
        const canChange = !!user && (isStaffUser(user) || ownNote);
        const type = fileTypeOf(note);

        const download = ()=>{
          downloadNoteFile(note);
          act.bumpDownloads(note.id);
          toast("Download started — “"+note.title+"”.");
        };
        const postComment = async e=>{
          e.preventDefault();
          if(!user){ go("login"); return; }
          if(!commentText.trim()) return;
          const res = await act.addComment(note.id, commentText.trim());
          if(res.ok) setCommentText("");
          else toast(res.error);
        };
        const doRate = async i=>{
          const res = await act.rate(note.id, i);
          if(res.ok) toast("Thanks for rating!");
          else toast(res.error);
        };
        const doBookmark = async ()=>{
          const res = await act.toggleBookmark(note.id);
          if(!res.ok) toast(res.error);
        };
        const doDeleteComment = async id=>{
          const res = await act.deleteComment(id);
          if(!res.ok) toast(res.error);
        };

        return html`<div class="view"><div class="wrap"><div class="page">
          <button class="back-link" onClick=${()=>go("browse")}>← Back to all notes</button>
          <div class="detail-grid">
            <div class="stack">
              <section class="card p8">
                ${!approved && html`<${AlertBox} kind="info">This note is <b>${note.status}</b>${note.status==="pending" ? " and waiting for admin approval. Only you and the admins can see it." : ". Only you and the admins can see it."}</${AlertBox}>`}
                <div style=${{display:"flex",flexWrap:"wrap",alignItems:"center",gap:"12px"}}>
                  <${FileBadge} type=${type} />
                  ${course && html`<span class="dept-pill">${course.dept} · Semester ${course.sem}</span>`}
                  ${!approved && html`<${StatusBadge} status=${note.status} />`}
                </div>
                <h1 class="note-title">${note.title}</h1>
                <p class="note-course">${course ? course.code+" · "+course.title : ""}</p>
                <div style=${{marginTop:"12px"}}><${Stars} avg=${r.avg} count=${r.count} /></div>
                ${note.desc ? html`<p class="note-desc">${note.desc}</p>` : null}
                <div class="note-actions">
                  ${user
                    ? html`<button class="btn-gold" onClick=${download}><${Icon} name="download" size=${18} /> Download</button>
                      ${approved && html`<button class="btn-ghost" aria-pressed=${bookmarked} onClick=${doBookmark}>
                        ${bookmarked
                          ? html`<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">${PATHS.bookmark}</svg>`
                          : html`<${Icon} name="bookmark" size=${18} />`}
                        ${bookmarked ? "Remove bookmark" : "Bookmark"}
                      </button>`}
                      ${canChange && html`<button class="btn-danger-o" onClick=${()=>setConfirmDel(true)}>
                        <${Icon} name="trash" size=${18} /> Delete note
                      </button>`}`
                    : html`<button class="btn-gold" onClick=${()=>go("login")}>Log in to download</button>`}
                </div>
              </section>

              <section class="card p8">
                <h2 class="sec-h2" style=${{margin:"0 0 8px"}}>${note.fileName}</h2>
                <p style=${{margin:"0 0 16px",fontSize:"15px",color:"var(--dim)"}}>The file itself is below — a PDF shows as a PDF and a photo shows as a photo, right on this page. Downloading asks you to log in.</p>
                <${NoteFileViewer} state=${state} user=${user} note=${note} go=${go} />
              </section>

              <section class="card p8">
                <h2 class="sec-h2">Comments (${comments.length})</h2>
                ${approved && user && html`<form onSubmit=${postComment} style=${{marginBottom:"20px"}}>
                  <label class="sr" htmlFor="cm">Write a comment</label>
                  <textarea id="cm" class="in" rows="3" maxLength="1000" required placeholder="Write a comment"
                    value=${commentText} onInput=${e=>setCommentText(e.target.value)}></textarea>
                  <button class="btn-ink" type="submit" style=${{marginTop:"12px"}} disabled=${!commentText.trim()}>Post comment</button>
                </form>`}
                ${approved && !user && html`<p class="login-prompt" style=${{marginBottom:"16px"}}>
                  <button onClick=${()=>go("login")}>Log in</button> to write a comment.</p>`}
                ${comments.length===0
                  ? html`<p style=${{color:"var(--dim)",margin:0}}>No comments yet.</p>`
                  : html`<div class="comments-list">
                      ${comments.map(c=>{
                        const cu = state.users.find(u=>u.id===c.userId) || (c.name ? { id:c.userId, name:c.name } : null);
                        return html`<div class="comment-row" key=${c.id}>
                          <${Avatar} user=${cu} />
                          <div style=${{minWidth:0}}>
                            ${cu ? html`<button class="nm author-link" style=${{fontSize:"15px"}} onClick=${()=>go("contributor", cu.id)}>${cu.name}</button>` : html`<span class="nm">Unknown</span>`}
                            <span class="dt">${fmtDate(c.created)}</span>
                            ${user && (isStaffUser(user) || user.id===c.userId) &&
                              html`<button class="del" onClick=${()=>doDeleteComment(c.id)}>Delete</button>`}
                            <p class="tx">${c.text}</p>
                          </div>
                        </div>`;
                      })}
                    </div>`}
              </section>
            </div>

            <div class="stack">
              <section class="card">
                <h3 style=${{fontSize:"20px",fontWeight:600,marginBottom:"12px"}}>Rate this note</h3>
                ${!approved
                  ? html`<p style=${{color:"var(--dim)",margin:0}}>This note can be rated after an admin approves it.</p>`
                  : !user
                    ? html`<p class="login-prompt" style=${{margin:0}}><button onClick=${()=>go("login")}>Log in</button> to rate this note.</p>`
                    : ownNote
                      ? html`<p style=${{color:"var(--dim)",margin:0}}>You cannot rate your own note.</p>`
                      : html`<div>
                          <div class="rate-stars" role="group" aria-label="Rate this note from 1 to 5 stars">
                            ${[1,2,3,4,5].map(i=>html`<button key=${i} class=${i<=myRating ? "lit" : ""} aria-label=${"Rate "+i+" stars"}
                              onClick=${()=>doRate(i)}>★</button>`)}
                          </div>
                          <p class="rate-note">${myRating ? "Your rating: "+myRating+" out of 5" : "Tap a star to rate"}</p>
                        </div>`}
              </section>

              <section class="card details">
                <h3 style=${{fontSize:"20px",fontWeight:600,marginBottom:"12px"}}>Details</h3>
                <dl>
                  <dt>Course</dt><dd>${course ? course.code+" — "+course.title : ""}</dd>
                  <dt>Department</dt><dd>${course ? course.dept : ""}</dd>
                  <dt>Semester</dt><dd>${course ? "Semester "+course.sem : ""}</dd>
                  <dt>Uploaded by</dt><dd>${author ? html`<button class="author-link" onClick=${()=>go("contributor", author.id)}>${author.name}</button>` : "Unknown"}</dd>
                  <dt>Date</dt><dd>${fmtDate(note.created)}</dd>
                  <dt>File</dt><dd class="brk">${note.fileName}</dd>
                  <dt>Size</dt><dd>${note.fileSize ? fmtSize(note.fileSize) : "—"}</dd>
                  <dt>Downloads</dt><dd>${note.downloads}</dd>
                </dl>
              </section>

              ${author && html`<section class="card">
                <h3 style=${{fontSize:"20px",fontWeight:600,marginBottom:"12px"}}>About the uploader</h3>
                <div style=${{display:"flex",alignItems:"center",gap:"12px"}}>
                  <${Avatar} user=${author} cls="avatar lg" />
                  <div style=${{minWidth:0}}>
                    <b style=${{display:"block",fontSize:"16px"}}>${author.name}</b>
                    <small style=${{color:"var(--dim)"}}>${author.dept || ""}${author.dept ? " · " : ""}${state.notes.filter(n=>n.userId===author.id && n.status==="approved").length} shared note(s)</small>
                  </div>
                </div>
                <p style=${{margin:"12px 0 0",fontSize:"14px",color:"var(--dim)"}}>See their details and every note they have shared on the portal.</p>
                <button class="btn-ghost" style=${{marginTop:"16px",width:"100%"}} onClick=${()=>go("contributor", author.id)}>View ${author.name.split(" ")[0]}'s profile</button>
              </section>`}
            </div>
          </div>

          ${confirmDel && html`<div class="modal-veil" onClick=${()=>setConfirmDel(false)}>
            <div class="modal" role="dialog" aria-modal="true" aria-label="Delete this note" onClick=${e=>e.stopPropagation()}>
              <h2>Delete this note?</h2>
              <p class="body">“${note.title}” will be deleted permanently, along with its ratings and comments.</p>
              <div class="actions">
                <button class="btn-ghost" onClick=${()=>setConfirmDel(false)}>Cancel</button>
                <button class="btn-danger" onClick=${async ()=>{ const res = await act.deleteNote(note.id); setConfirmDel(false); if(res.ok){ toast("Note deleted."); go("browse"); } else toast(res.error); }}>Delete note</button>
              </div>
            </div>
          </div>`}
        </div></div></div>`;
      }



      /* ================= Upload ================= */
            function Upload({ state, user, go, act, toast }){
        const [dept,setDept] = useState(""); const [sem,setSem] = useState("");
        const [code,setCode] = useState(""); const [title,setTitle] = useState("");
        const [noteTitle,setNoteTitle] = useState(""); const [desc,setDesc] = useState("");
        const [fileName,setFileName] = useState(""); const [fileSize,setFileSize] = useState(0);
        const [fileData,setFileData] = useState("");
        const [err,setErr] = useState(""); const [busy,setBusy] = useState(false);
        if(!user) return html`<div class="view"><div class="wrap"><div class="page">
          <${EmptyState} title="Log in to upload a note" body="You need an account to share notes with other students.">
            <div class="cta"><button class="btn-gold" onClick=${()=>go("login")}>Log in</button></div>
          </${EmptyState}>
        </div></div></div>`;
        /* The file is read in the browser and sent to the backend, which
           stores the real file — a PDF or photo up to 10 MB shows right
           on the note page after it is approved. */
        const onFile = e=>{
          const f = e.target.files && e.target.files[0];
          setFileName(f ? f.name : ""); setFileSize(f ? f.size : 0);
          setFileData("");
          if(!f) return;
          if(f.size > UPLOAD_FILE_MAX){ setErr("File is too large (maximum 10 MB)."); return; }
          const rd = new FileReader();
          rd.onload = ()=>setFileData(String(rd.result || ""));
          rd.readAsDataURL(f);
        };
        const isImg = /\.(png|jpe?g|gif|webp)$/i.test(fileName);
        const submit = async e=>{
          e.preventDefault(); setErr("");
          const res = resolveCourse(state, dept, sem, code, title);
          if(res.error){ setErr(res.error); return; }
          if(!noteTitle.trim()){ setErr("Please give your note a title."); return; }
          if(!fileName){ setErr("Please choose a file to upload."); return; }
          if(fileSize > UPLOAD_FILE_MAX){ setErr("File is too large (maximum 10 MB)."); return; }
          if(!fileData){ setErr("The file is still being read — please wait a moment and try again."); return; }
          /* The API takes raw base64 (no data: prefix) */
          const comma = fileData.indexOf(",");
          const b64 = comma>=0 ? fileData.slice(comma+1) : fileData;
          setBusy(true);
          const r = await act.addNote({ dept, sem, courseCode: cleanCode(code), courseTitle: title.trim(),
            title: noteTitle.trim(), desc: desc.trim(), fileName, fileData: b64 });
          setBusy(false);
          if(!r.ok){ setErr(r.error); return; }
          toast(r.status==="approved"
            ? "Uploaded and published."
            : (res.created
              ? "Uploaded! Your note is pending until an admin approves it — and the new course was added to the catalogue."
              : "Uploaded! Your note is pending until an admin approves it."));
          go("profile");
        };
        return html`<div class="view"><div class="wrap"><div class="page">
          <div class="page-head">
            <h1>Upload a note</h1>
            <p>Share your notes with other students. An admin checks every note before it goes live.</p>
          </div>
          <div class="upload-grid">
            <form class="card p8" onSubmit=${submit}>
              ${err && html`<${AlertBox} kind="error">${err}</${AlertBox}>`}
              <${CourseFields} courses=${state.courses} departments=${deptList(state)}
                dept=${dept} setDept=${setDept} sem=${sem} setSem=${setSem}
                code=${code} setCode=${setCode} title=${title} setTitle=${setTitle} />
              <${Field} label="Title">
                <input aria-label="Title" class="in" type="text" required minLength="3" maxLength="150"
                  placeholder="Example: SQL Joins Cheat Sheet" value=${noteTitle}
                  onInput=${e=>setNoteTitle(e.target.value)} />
              </${Field}>
              <${Field} label="Description">
                <textarea aria-label="Description" class="in" rows="4" maxLength="2000"
                  placeholder="What is in this note?" value=${desc}
                  onInput=${e=>setDesc(e.target.value)}></textarea>
              </${Field}>
              <${Field} label="File" hint="PDF, DOC, DOCX, PPT, PPTX, PNG or JPG, up to 10 MB. The real file is stored on the server, so a PDF or photo shows right on the note page.">
                <input aria-label="File" class="file-in" type="file" required
                  accept=".pdf,.doc,.docx,.ppt,.pptx,.png,.jpg,.jpeg"
                  onChange=${onFile} />
                ${fileName ? html`<p class="file-note">${fileName} · ${fmtSize(fileSize)}${fileData
                  ? " · The file itself will show right on the note page."
                  : ""}</p>` : null}
                ${fileData && isImg ? html`<img class="upload-thumb" src=${fileData} alt="The photo you chose for this note" />` : null}
              </${Field}>
              <button class="btn-gold" type="submit" disabled=${busy} style=${{padding:"12px 32px",fontSize:"16px"}}>
                <${Icon} name="upload" size=${18} /> ${busy ? "Uploading…" : "Upload note"}
              </button>
            </form>
            <aside class="card aside-card">
              <h3>Before you upload</h3>
              <ul>
                <li>Upload your own work, or notes you have the right to share.</li>
                <li>Pick the right department and semester, then type the course code and its subject title — both are required, so others can find your note easily. If the course is not listed yet, typing it adds it.</li>
                <li>Your note will show as <b>pending</b> until an admin approves it.</li>
                <li>PDF and photo notes open on the site itself, so classmates can read yours before they download it.</li>
              </ul>
            </aside>
          </div>
        </div></div></div>`;
      }



      /* ================= Auth ================= */
      /* Auth pages (Log in / Create account / Forgot password / Verify
         email): the side panel is a dark welcome card, not a photo. The
         building photo that used to sit here was removed at the user's
         request. The panel shows what members can do and live catalogue
         stats (courses / departments / semesters) with a counting
         animation. Home's hero/gate/pano photos are untouched. */
      function AuthShell({ heading, sub, state, children }){
        const courses = (state && state.courses) || [];
        const depts = (state && state.departments && state.departments.length) ? state.departments : DEPARTMENTS;
        return html`<div class="view"><div class="wrap"><div class="auth-grid">
          <div class="auth-welcome">
            <div class="txt">
              <h2>${heading}</h2>
              <p>${sub}</p>
              <ul class="auth-do">
                <li>Upload your own notes and share them with your batch</li>
                <li>Download notes, past questions and assignment solutions</li>
                <li>Rate notes and bookmark the ones you need</li>
                <li>Get help from the Support page when something goes wrong</li>
              </ul>
              <div class="auth-stats">
                <div class="auth-stat"><b><${CountUp} value=${courses.length} /></b><span>Courses</span></div>
                <div class="auth-stat"><b><${CountUp} value=${depts.length} /></b><span>Departments</span></div>
                <div class="auth-stat"><b><${CountUp} value=${12} /></b><span>Semesters</span></div>
              </div>
            </div>
          </div>
          <div class="auth-side"><div class="auth-box">${children}</div></div>
        </div></div></div>`;
      }

            function Login({ state, go, act, toast }){
        const [email,setEmail] = useState(""); const [pw,setPw] = useState(""); const [err,setErr] = useState("");
        const [busy,setBusy] = useState(false);
        const [verify,setVerify] = useState(null); const [note,setNote] = useState("");
        const submit = async e=>{
          e.preventDefault(); setErr(""); setNote("");
          setBusy(true);
          const r = await act.login(email.trim(), pw);
          setBusy(false);
          if(!r.ok){
            setErr(r.error);
            /* Email not verified yet: offer the verification step (with a
               resend) instead of a dead end. The email is already filled in. */
            if(r.code==="EMAIL_NOT_VERIFIED") setVerify(email.trim());
            return;
          }
          const u = r.user;
          toast("Welcome back, "+u.name.split(" ")[0]+".");
          go(isStaffUser(u) ? "admin" : "home");
        };
        if(verify) return html`<${VerifyEmail} email=${verify}
          heading="Your email is not verified yet."
          sub="Enter the 6-digit code we sent you, or ask for a new one."
          onDone=${()=>{ setVerify(null); setNote("Your email is verified. Please log in again."); }}
          go=${go} act=${act} state=${state} />`;
        return html`<${AuthShell} state=${state}
          heading="Welcome back to your notes library."
          sub="Log in to upload, download, rate and bookmark notes shared by City University students.">
          <h1>Log in</h1>
          <p class="sub">Use your email and password.</p>
          ${note && html`<${AlertBox} kind="info">${note}</${AlertBox}>`}
          ${err && html`<${AlertBox} kind="error">${err}</${AlertBox}>`}
          <form onSubmit=${submit}>
            <${Field} label="Email">
              <input aria-label="Email" class="in" type="email" autoComplete="email" required
                value=${email} onInput=${e=>setEmail(e.target.value)} />
            </${Field}>
            <${PasswordInput} label="Password" value=${pw} onInput=${e=>setPw(e.target.value)}
              autoComplete="current-password" required />
            <button class="btn-gold btn-lg" type="submit" disabled=${busy} style=${{width:"100%"}}>${busy ? "Logging in…" : "Log in"}</button>
          </form>
          <div class="auth-links">
            <button class="gold" onClick=${()=>go("forgot")}>Forgot password?</button>
            <span class="dim">New here? <button class="strong" onClick=${()=>go("register")}>Create an account</button></span>
          </div>
        </${AuthShell}>`;
      }

      /* Email verification, shared by Register (after sign-up) and Login
         (when login is refused as EMAIL_NOT_VERIFIED): a 6-digit code was
         emailed to the account, and the code is entered here. Resend has a
         60-second cooldown on the button. */
      function VerifyEmail({ email, heading, sub, onDone, go, act, state }){
        const [code,setCode] = useState("");
        const [err,setErr] = useState(""); const [busy,setBusy] = useState(false);
        const [sentMsg,setSentMsg] = useState("");
        const [cooldown,setCooldown] = useState(0);
        useEffect(()=>{ if(cooldown<=0) return; const t=setTimeout(()=>setCooldown(cooldown-1),1000); return ()=>clearTimeout(t); },[cooldown]);
        const submit = async e=>{
          e.preventDefault(); setErr("");
          if(!/^\d{6}$/.test(code.trim())){ setErr("Enter the 6-digit code from your email."); return; }
          setBusy(true);
          const r = await act.verifyEmail(email, code.trim());
          setBusy(false);
          if(!r.ok){ setErr(r.error); return; }
          if(onDone) onDone();
        };
        const resend = async ()=>{
          setErr(""); setSentMsg("");
          const r = await act.resendVerification(email);
          if(!r.ok){ setErr(r.error); return; }
          setSentMsg("A new code was sent to "+email+".");
          setCooldown(60);
        };
        return html`<${AuthShell} state=${state}
          heading=${heading}
          sub=${sub}>
          <h1>Check your email</h1>
          <p class="sub">We sent a 6-digit code to <b>${email}</b>. Enter it below to verify your email — the code works for 15 minutes.</p>
          ${err && html`<${AlertBox} kind="error">${err}</${AlertBox}>`}
          ${sentMsg && html`<${AlertBox} kind="info">${sentMsg}</${AlertBox}>`}
          <form onSubmit=${submit}>
            <${Field} label="Verification code">
              <input aria-label="Verification code" class="in" type="text" inputMode="numeric" required
                maxLength="6" placeholder="6-digit code" value=${code}
                onInput=${e=>setCode(e.target.value.replace(/[^0-9]/g,"").slice(0,6))} />
            </${Field}>
            <button class="btn-gold btn-lg" type="submit" disabled=${busy} style=${{width:"100%"}}>${busy ? "Verifying…" : "Verify email"}</button>
          </form>
          <p class="auth-foot">Didn't get a code? ${cooldown>0
            ? html`<span class="dim">Resend in ${cooldown}s</span>`
            : html`<button class="strong" onClick=${resend}>Resend code</button>`}</p>
          <p class="auth-foot">Changed your mind? <button class="strong" onClick=${()=>go("login")}>Back to log in</button></p>
        </${AuthShell}>`;
      }

      function Register({ state, go, act, toast }){
        const [name,setName] = useState(""); const [email,setEmail] = useState("");
        const [pw,setPw] = useState(""); const [dept,setDept] = useState("");
        const [studentId,setStudentId] = useState(""); const [phone,setPhone] = useState("");
        const [err,setErr] = useState(""); const [busy,setBusy] = useState(false);
        const [done,setDone] = useState(false);
        const [verify,setVerify] = useState(null); // email waiting for its code
        const submit = async e=>{
          e.preventDefault(); setErr("");
          if(!name.trim()){ setErr("Type your full name."); return; }
          if(!/^\S+@\S+\.\S+$/.test(email.trim())){ setErr("Enter a valid email address."); return; }
          if(pw.length<8){ setErr("Password must be at least 8 characters."); return; }
          if(!/^\d{12}$/.test(studentId.trim())){ setErr("Student ID must be exactly 12 numbers — digits only, no letters or spaces."); return; }
          if(!/^\d{10,15}$/.test(phone.trim())){ setErr("Phone number must be 10 to 15 digits."); return; }
          if(!dept){ setErr("Pick your department."); return; }
          setBusy(true);
          const r = await act.register({ name:name.trim(), email:email.trim(), dept, password:pw,
            studentId:studentId.trim(), phone:phone.trim() });
          setBusy(false);
          if(!r.ok){ setErr(r.error); return; }
          /* Email verification is on: the code is in the inbox, so show the
             verification step first. Otherwise go straight to "not active yet". */
          if(r.needsVerification){ setVerify(r.email || email.trim()); return; }
          setDone(true);
        };
        if(verify) return html`<${VerifyEmail} email=${verify}
          heading="Almost there — check your email."
          sub="A 6-digit code is on its way to your inbox."
          onDone=${()=>{ setVerify(null); setDone(true); }} go=${go} act=${act} state=${state} />`;
        if(done) return html`<${AuthShell} state=${state}
          heading="Your account is on its way."
          sub="An admin will review your sign-up, and then you can log in.">
          <h1>Account created — not active yet</h1>
          <p class="sub">Your account was created, but it stays inactive until an admin approves it. This keeps the portal safe from fake accounts. Please check back after an admin has approved you, then log in with your email and password.</p>
          <div class="auth-links">
            <button class="btn-gold btn-lg" style=${{width:"100%"}} onClick=${()=>go("login")}>Go to log in</button>
          </div>
          <p class="auth-foot">Want to look around first? <button class="strong" onClick=${()=>go("home")}>Back to Home</button></p>
        </${AuthShell}>`;
        return html`<${AuthShell} state=${state}
          heading="Join your classmates' library."
          sub="Create a free account to upload your own notes and download what your batch has shared.">
          <h1>Create an account</h1>
          <p class="sub">Sign up as a student in a minute.</p>
          ${err && html`<${AlertBox} kind="error">${err}</${AlertBox}>`}
          <form onSubmit=${submit}>
            <${Field} label="Full name">
              <input aria-label="Full name" class="in" type="text" autoComplete="name" required minLength="2" maxLength="100"
                value=${name} onInput=${e=>setName(e.target.value)} />
            </${Field}>
            <${Field} label="Email">
              <input aria-label="Email" class="in" type="email" autoComplete="email" required
                value=${email} onInput=${e=>setEmail(e.target.value)} />
            </${Field}>
            <${Field} label="Student ID" hint="Exactly 12 numbers — digits only, no letters or spaces">
              <input aria-label="Student ID" class="in" type="text" inputMode="numeric" required
                minLength="12" maxLength="12" placeholder="Example: 0272XXXXXXXX"
                value=${studentId} onInput=${e=>setStudentId(e.target.value.replace(/[^0-9]/g,"").slice(0,12))} />
            </${Field}>
            <${Field} label="Phone number" hint="10 to 15 digits">
              <input aria-label="Phone number" class="in" type="tel" inputMode="numeric" required
                minLength="10" maxLength="15" placeholder="Example: 01712345678"
                value=${phone} onInput=${e=>setPhone(e.target.value.replace(/[^0-9]/g,"").slice(0,15))} />
            </${Field}>
            <${PasswordInput} label="Password" hint="At least 8 characters" value=${pw}
              onInput=${e=>setPw(e.target.value)} autoComplete="new-password" required minLength=${8} />
            <${Field} label="Department">
              <select aria-label="Department" class="in" value=${dept} onChange=${e=>setDept(e.target.value)}>
                <option value="">Choose a department</option>
                ${deptList(state).map(d=>html`<option key=${d} value=${d}>${d}</option>`)}
              </select>
            </${Field}>
            <button class="btn-gold btn-lg" type="submit" disabled=${busy} style=${{width:"100%"}}>${busy ? "Creating account…" : "Create account"}</button>
          </form>
          <p class="auth-foot">Already registered? <button class="strong" onClick=${()=>go("login")}>Log in</button></p>
        </${AuthShell}>`;
      }

      function Forgot({ state, go, act, toast }){
        const [requested,setRequested] = useState(false);
        const [email,setEmail] = useState(""); const [code,setCode] = useState("");
        const [typed,setTyped] = useState(""); const [pw,setPw] = useState("");
        const [err,setErr] = useState(""); const [busy,setBusy] = useState(false);
        const request = async e=>{
          e.preventDefault(); setErr("");
          setBusy(true);
          const r = await act.forgot(email.trim());
          setBusy(false);
          if(!r.ok){ setErr(r.error); return; }
          if(r.code) setCode(r.code);
          setRequested(true);
        };
        const verify = async e=>{
          e.preventDefault(); setErr("");
          if(!typed.trim()){ setErr("Type the 6-digit code."); return; }
          if(pw.length<8){ setErr("New password must be at least 8 characters."); return; }
          setBusy(true);
          const r = await act.resetPassword(email.trim().toLowerCase(), typed.trim(), pw);
          setBusy(false);
          if(!r.ok){ setErr(r.error); return; }
          toast("Password changed. Please log in with your new password.");
          go("login");
        };
        return html`<${AuthShell} state=${state}
          heading="Forgot your password?"
          sub="We will create a 6-digit reset code that works for 15 minutes.">
          <h1>Reset password</h1>
          <p class="sub">Enter your account email to get a reset code.</p>
          ${err && html`<${AlertBox} kind="error">${err}</${AlertBox}>`}
          ${!requested
            ? html`<form onSubmit=${request}>
                <${Field} label="Email">
                  <input aria-label="Email" class="in" type="email" autoComplete="email" required
                    value=${email} onInput=${e=>setEmail(e.target.value)} />
                </${Field}>
                <button class="btn-gold btn-lg" type="submit" disabled=${busy} style=${{width:"100%"}}>${busy ? "Please wait…" : "Get reset code"}</button>
              </form>`
            : html`<div>
                ${code
                  ? html`<${AlertBox} kind="info">Your reset code is <b class="code-big">${code}</b>
                      <span style=${{display:"block",marginTop:"4px",fontSize:"13px"}}>This demo setup shows the code on the page. On a real site it would be emailed to you.</span>
                    </${AlertBox}>`
                  : html`<${AlertBox} kind="info">If this email is registered, a reset code has been created. It is printed in the backend server window.</${AlertBox}>`}
                <form onSubmit=${verify}>
                  <${Field} label="Reset code">
                    <input aria-label="Reset code" class="in" type="text" inputMode="numeric" required maxLength="10"
                      value=${typed} onInput=${e=>setTyped(e.target.value.replace(/[^0-9]/g,""))} />
                  </${Field}>
                  <${PasswordInput} label="New password" hint="At least 8 characters" value=${pw}
                    onInput=${e=>setPw(e.target.value)} autoComplete="new-password" required minLength=${8} />
                  <button class="btn-gold btn-lg" type="submit" disabled=${busy} style=${{width:"100%"}}>${busy ? "Please wait…" : "Set new password"}</button>
                </form>
              </div>`}
          <p class="auth-foot">Remembered it? <button class="strong" onClick=${()=>go("login")}>Back to log in</button></p>
        </${AuthShell}>`;
      }



      /* ================= Public contributor profile ================= */
      /* Anyone can open this from a note card, a note page, or a comment:
         it shows the sharer's details and every approved note they shared.
         Private things (password, own pending/rejected notes, bookmarks)
         are never shown here — only the owner sees those in My profile. */
            function ContributorProfile({ state, user, contributorId, go, act, toast }){
        const [data, setData] = useState(null);
        const [loading, setLoading] = useState(true);
        const [confirmReject, setConfirmReject] = useState(false);
        const [busy, setBusy] = useState(false);
        useEffect(()=>{
          let on = true;
          if(!user){ setLoading(false); return; }
          setLoading(true); setData(null);
          act.loadContributor(contributorId).then(r=>{ if(on){ if(r.ok) setData(r.data); setLoading(false); } });
          return ()=>{ on = false; };
        },[contributorId]);
        /* Contributor profiles are for logged-in members only. */
        if(!user) return html`<div class="view"><div class="wrap"><div class="page">
          <${EmptyState} title="Log in to see this profile" body="Member profiles open after you log in — browse the notice board while you are here.">
            <div class="cta"><button class="btn-gold" onClick=${()=>go("login")}>Log in</button>
            <button class="btn-ghost" onClick=${()=>go("register")}>Create an account</button></div>
          </${EmptyState}>
        </div></div></div>`;
        /* While the API answers, fall back to what is already cached */
        const cached = state.users.find(u=>u.id===contributorId);
        const profile = data ? data.profile : (cached ? {
          id:cached.id, name:cached.name, dept:cached.dept, role:cached.role, joined:cached.joined,
          notesShared: state.notes.filter(n=>n.userId===cached.id && n.status==="approved").length,
          totalDownloads: state.notes.filter(n=>n.userId===cached.id && n.status==="approved").reduce((a,n)=>a+(n.downloads||0),0),
          avgRating: 0, departments: [], suspended: !!cached.suspended, approved: cached.approved !== false
        } : null);
        const shared = data
          ? data.notes.map(normNote).sort((a,b)=>b.created-a.created)
          : state.notes.filter(n=>n.userId===contributorId && n.status==="approved").sort((a,b)=>b.created-a.created);
        if(!profile && loading) return html`<div class="view"><div class="wrap"><div class="page">
          <p style=${{color:"var(--dim)"}}>Loading the profile…</p>
        </div></div></div>`;
        if(!profile) return html`<div class="view"><div class="wrap"><div class="page">
          <${EmptyState} title="Profile not found" body="This student does not exist, or their account was removed.">
            <div class="cta"><button class="btn-ink" onClick=${()=>go("browse")}>Notes</button></div>
          </${EmptyState}>
        </div></div></div>`;
        const target = { id:profile.id, name:profile.name, dept:profile.dept, role:profile.role,
          joined:profile.joined, suspended:profile.suspended, photo: (cached && cached.photo) || (data && data.profile && data.profile.photo) || null };
        const totalDownloads = data ? profile.totalDownloads : shared.reduce((a,n)=>a+(n.downloads||0),0);
        const avg = data ? profile.avgRating : (shared.length ? shared.reduce((a,n)=>a+(n.avg||0),0)/shared.length : 0);
        const ratingsCount = shared.reduce((a,n)=>a+(n.count||0),0);
        const deptsShared = data ? profile.departments
          : [...new Set(shared.map(n=>{ const c = state.courses.find(cc=>cc.id===n.courseId); return c ? c.dept : null; }).filter(Boolean))];
        const isSelf = !!user && user.id===profile.id;
        const account = data ? data.account : null;
        const viewerIsAdmin = data ? data.viewerIsAdmin : false;
        const doApprove = async ()=>{
          setBusy(true);
          const r = await act.approveUser(profile.id);
          setBusy(false);
          if(r.ok){ toast(profile.name+" approved — they can log in now."); const d = await act.loadContributor(contributorId); if(d.ok) setData(d.data); }
          else toast(r.error);
        };
        const doReject = async ()=>{
          setBusy(true);
          const r = await act.rejectUser(profile.id);
          setBusy(false);
          setConfirmReject(false);
          if(r.ok){ toast("Sign-up rejected — the account was removed."); go("admin"); }
          else toast(r.error);
        };
        return html`<div class="view"><div class="wrap"><div class="page">
          <button class="back-link" onClick=${()=>go("browse")}>← Back to all notes</button>
          <section class="card p8" style=${{marginBottom:"28px"}}>
            <div class="contrib-hero">
              <${Avatar} user=${target} cls="contrib-avatar" />
              <div style=${{flex:"1 1 320px",minWidth:0}}>
                <p class="kicker plain" style=${{marginBottom:"6px"}}>Contributor profile</p>
                <h1 style=${{fontSize:"34px",fontWeight:600,lineHeight:1.15}}>${profile.name}</h1>
                <div class="contrib-meta">
                  ${profile.dept && html`<span class="dept-pill">${profile.dept} Department</span>`}
                  <span class=${"badge-role "+profile.role} style=${{textTransform:"capitalize"}}>${profile.role}</span>
                  ${profile.suspended && html`<span class="badge-suspended">Suspended</span>`}
                  ${profile.approved===false && html`<span class="badge-suspended">Waiting for approval</span>`}
                  <span class="badge-role">Joined ${fmtDate(profile.joined)}</span>
                  ${deptsShared.length ? html`<span class="badge-role">Shares in: ${deptsShared.join(", ")}</span>` : null}
                </div>
                <p class="contrib-about">${profile.name} is ${profile.role==="admin" ? "an admin" : profile.role==="moderator" ? "a moderator" : "a "+(profile.dept ? profile.dept+" " : "")+"student"} at City University sharing study notes on the portal. Below are all the notes they have shared — open any note to see its file, download, rate or comment on it.</p>
                ${profile.suspended && html`<${AlertBox} kind="error">This account is currently suspended by an admin, so it cannot log in or share new notes.</${AlertBox}>`}
                ${profile.approved===false && html`<${AlertBox} kind="info">This account is waiting for admin approval, so it cannot log in yet.</${AlertBox}>`}
                ${isSelf && html`<div style=${{marginTop:"16px",display:"flex",flexWrap:"wrap",gap:"10px"}}>
                  <button class="btn-ink" onClick=${()=>go("profile")}>Go to My profile</button>
                  <button class="btn-ghost" onClick=${()=>go("upload")}>Upload a note</button>
                </div>`}
              </div>
            </div>
            <div class="contrib-stats">
              ${[
                { value: profile.notesShared, label:"Shared notes" },
                { value: totalDownloads, label:"Total downloads" },
                { value: avg ? avg.toFixed(1)+" ★" : "—", label:"Average rating" },
                { value: ratingsCount, label:"Ratings received" }
              ].map(s=>html`<div class="stat-card" key=${s.label}><b>${typeof s.value==="number" ? html`<${CountUp} value=${s.value} />` : s.value}</b><span>${s.label}</span></div>`)}
            </div>
            <dl style=${{display:"grid",gridTemplateColumns:"auto 1fr",gap:"10px 20px",fontSize:"15px",margin:"24px 0 0"}}>
              <dt style=${{fontWeight:600,color:"var(--dim)"}}>Full name</dt><dd style=${{margin:0}}>${profile.name}</dd>
              <dt style=${{fontWeight:600,color:"var(--dim)"}}>Department</dt><dd style=${{margin:0}}>${profile.dept || "—"}</dd>
              <dt style=${{fontWeight:600,color:"var(--dim)"}}>Role</dt><dd style=${{margin:0,textTransform:"capitalize"}}>${profile.role}</dd>
              <dt style=${{fontWeight:600,color:"var(--dim)"}}>Member since</dt><dd style=${{margin:0}}>${fmtDate(profile.joined)}</dd>
            </dl>
          </section>

          ${viewerIsAdmin && account && html`<section class="card p8" style=${{marginBottom:"28px"}}>
            <h2 class="sec-h2">Account details <span style=${{fontSize:"13px",color:"var(--dim)",fontWeight:400}}>— only admins see this</span></h2>
            <dl style=${{display:"grid",gridTemplateColumns:"auto 1fr",gap:"10px 20px",fontSize:"15px",margin:"0"}}>
              <dt style=${{fontWeight:600,color:"var(--dim)"}}>Full name</dt><dd style=${{margin:0}}>${account.name}</dd>
              <dt style=${{fontWeight:600,color:"var(--dim)"}}>Email</dt><dd style=${{margin:0}}>${account.email}</dd>
              <dt style=${{fontWeight:600,color:"var(--dim)"}}>Student ID</dt><dd style=${{margin:0}}>${account.studentId || "—"}</dd>
              <dt style=${{fontWeight:600,color:"var(--dim)"}}>Phone number</dt><dd style=${{margin:0}}>${account.phone || "—"}</dd>
              <dt style=${{fontWeight:600,color:"var(--dim)"}}>Department</dt><dd style=${{margin:0}}>${account.dept || "—"}</dd>
              <dt style=${{fontWeight:600,color:"var(--dim)"}}>Role</dt><dd style=${{margin:0,textTransform:"capitalize"}}>${account.role}</dd>
              <dt style=${{fontWeight:600,color:"var(--dim)"}}>Sign-up date</dt><dd style=${{margin:0}}>${fmtDate(account.joined)}</dd>
              <dt style=${{fontWeight:600,color:"var(--dim)"}}>Account status</dt><dd style=${{margin:0}}>${account.suspended ? "Suspended" : account.approved ? "Active" : "Waiting for approval"}</dd>
              <dt style=${{fontWeight:600,color:"var(--dim)"}}>Notes shared</dt><dd style=${{margin:0}}>${account.notesShared}</dd>
            </dl>
            ${account.approved===false && html`<div style=${{marginTop:"20px",display:"flex",flexWrap:"wrap",gap:"10px"}}>
              <button class="btn-gold" disabled=${busy} onClick=${doApprove}>Approve account</button>
              <button class="btn-danger-o" disabled=${busy} onClick=${()=>setConfirmReject(true)}>Reject sign-up</button>
            </div>`}
          </section>`}

          <div class="lib-head" style=${{marginBottom:"24px"}}>
            <div>
              <p class="kicker plain">Shared by ${profile.name.split(" ")[0]}</p>
              <h2 style=${{fontSize:"30px"}}>Notes shared by ${profile.name} (${shared.length})</h2>
            </div>
            <button class="btn-ghost" onClick=${()=>go("browse")}>All notes</button>
          </div>
          ${shared.length===0
            ? html`<${EmptyState} title="No shared notes yet" body=${profile.name+" has not shared any approved notes yet. Check back later, or see notes from other students."}>
                <div class="cta"><button class="btn-ink" onClick=${()=>go("browse")}>Notes</button></div>
              </${EmptyState}>`
            : html`<div class="grid3 browse-grid">${shared.map(n=>html`<${NoteCard} key=${n.id} state=${state} note=${n} go=${go} />`)}</div>`}

          ${confirmReject && html`<div class="modal-veil" onClick=${()=>setConfirmReject(false)}>
            <div class="modal" role="dialog" aria-modal="true" aria-label="Reject this sign-up" onClick=${e=>e.stopPropagation()}>
              <h2>Reject this sign-up?</h2>
              <p class="body">${profile.name}'s account will be deleted permanently.</p>
              <div class="actions">
                <button class="btn-ghost" onClick=${()=>setConfirmReject(false)}>Cancel</button>
                <button class="btn-danger" disabled=${busy} onClick=${doReject}>Reject sign-up</button>
              </div>
            </div>
          </div>`}
        </div></div></div>`;
      }



      /* ================= Profile (details, bookmarks, uploads) ================= */
            function Profile({ state, user, go, act, toast }){
        const [name,setName] = useState(user ? user.name : "");
        const [dept,setDept] = useState(user ? user.dept : "");
        const [studentId,setStudentId] = useState(user ? (user.studentId || "") : "");
        const [phone,setPhone] = useState(user ? (user.phone || "") : "");
        const [cur,setCur] = useState(""); const [npw,setNpw] = useState(""); const [npw2,setNpw2] = useState("");
        const [profileMsg,setProfileMsg] = useState(null);
        const [passMsg,setPassMsg] = useState(null);
        const [editing,setEditing] = useState(null);
        const [deleting,setDeleting] = useState(null);
        const [photoBusy,setPhotoBusy] = useState(false);
        const photoInput = useRef(null);
        if(!user) return html`<div class="view"><div class="wrap"><div class="page">
          <${EmptyState} title="Log in to see your profile" body="Your details, uploads and saved notes live here once you are signed in.">
            <div class="cta"><button class="btn-gold" onClick=${()=>go("login")}>Log in</button></div>
          </${EmptyState}>
        </div></div></div>`;
        const myNotes = (state.myNotes.length ? state.myNotes : state.notes.filter(n=>n.userId===user.id))
          .sort((a,b)=>b.created-a.created);
        const myBookmarks = state.bookmarks
          .map(b=>state.notes.find(n=>n.id===b.noteId)).filter(n=>n && n.status==="approved");
        const saveProfile = async e=>{
          e.preventDefault(); setProfileMsg(null);
          if(!name.trim()){ setProfileMsg({kind:"error",text:"Your name cannot be empty."}); return; }
          if(!/^\d{12}$/.test(studentId.trim())){ setProfileMsg({kind:"error",text:"Student ID must be exactly 12 numbers — digits only, no letters or spaces."}); return; }
          if(!/^\d{10,15}$/.test(phone.trim())){ setProfileMsg({kind:"error",text:"Phone number must be 10 to 15 digits."}); return; }
          const r = await act.updateProfile({ name:name.trim(), dept, studentId:studentId.trim(), phone:phone.trim() });
          if(r.ok) setProfileMsg({kind:"success",text:"Profile saved."});
          else setProfileMsg({kind:"error",text:r.error});
        };
        const changePw = async e=>{
          e.preventDefault(); setPassMsg(null);
          if(npw.length<8){ setPassMsg({kind:"error",text:"New password must be at least 8 characters."}); return; }
          if(npw!==npw2){ setPassMsg({kind:"error",text:"The new passwords do not match."}); return; }
          const r = await act.changePassword(cur, npw);
          if(r.ok){ setCur(""); setNpw(""); setNpw2(""); setPassMsg({kind:"success",text:"Password changed."}); }
          else setPassMsg({kind:"error",text:r.error});
        };
        /* Profile photo: JPG/PNG/GIF/WebP up to 8 MB, downscaled to 256px */
        const onPhoto = e=>{
          const f = e.target.files && e.target.files[0];
          if(photoInput.current) photoInput.current.value = "";
          if(!f) return;
          if(!/^image\/(png|jpe?g|gif|webp)$/.test(f.type)){ setProfileMsg({kind:"error",text:"Please choose a JPG, PNG, GIF or WebP photo."}); return; }
          if(f.size > 8*1024*1024){ setProfileMsg({kind:"error",text:"Photo is too large (maximum 8 MB)."}); return; }
          const rd = new FileReader();
          rd.onload = ()=>{
            const img = new Image();
            img.onload = async ()=>{
              let url = String(rd.result || "");
              try{
                const size = 256;
                const canvas = document.createElement("canvas");
                canvas.width = size; canvas.height = size;
                const ctx = canvas.getContext("2d");
                const side = Math.min(img.width, img.height);
                ctx.drawImage(img, (img.width-side)/2, (img.height-side)/2, side, side, 0, 0, size, size);
                url = canvas.toDataURL("image/jpeg", 0.85);
              }catch(err){ /* canvas unavailable — send the file as-is */ }
              setPhotoBusy(true);
              const r = await act.setPhoto(url);
              setPhotoBusy(false);
              if(r.ok) setProfileMsg({kind:"success",text:"Profile photo saved."});
              else setProfileMsg({kind:"error",text:r.error});
            };
            img.onerror = ()=> setProfileMsg({kind:"error",text:"That photo could not be read."});
            img.src = String(rd.result || "");
          };
          rd.readAsDataURL(f);
        };
        const removePhoto = async ()=>{
          setPhotoBusy(true);
          const r = await act.setPhoto(null);
          setPhotoBusy(false);
          if(r.ok) setProfileMsg({kind:"success",text:"Profile photo removed."});
          else setProfileMsg({kind:"error",text:r.error});
        };
        return html`<div class="view"><div class="wrap"><div class="page">
          <div class="page-head">
            <h1>My profile</h1>
            <p>Your details, your uploads and your saved notes.</p>
          </div>
          <div class="prof-wrap">
            <div class="prof-top">
              <div class="prof-left">
                <section class="card p8">
                  <h2 class="sec-h2">Profile</h2>
                  <div style=${{display:"flex",alignItems:"center",gap:"16px",marginBottom:"20px",flexWrap:"wrap"}}>
                    <${Avatar} user=${user} cls="avatar lg" />
                    <div style=${{display:"flex",flexDirection:"column",gap:"8px"}}>
                      <input ref=${photoInput} type="file" accept=".jpg,.jpeg,.png,.gif,.webp" aria-label="Choose a profile photo"
                        style=${{display:"none"}} onChange=${onPhoto} />
                      <button class="pb pb-o" type="button" disabled=${photoBusy} onClick=${()=>photoInput.current && photoInput.current.click()}>
                        ${user.photo ? "Change photo" : "Add photo"}
                      </button>
                      ${user.photo && html`<button class="pb pb-danger" type="button" disabled=${photoBusy} onClick=${removePhoto}>Remove</button>`}
                      <small style=${{color:"var(--dim)"}}>JPG, PNG, GIF or WebP, up to 8 MB.</small>
                    </div>
                  </div>
                  ${profileMsg && html`<${AlertBox} kind=${profileMsg.kind}>${profileMsg.text}</${AlertBox}>`}
                  <form onSubmit=${saveProfile}>
                    <${Field} label="Full name">
                      <input aria-label="Full name" class="in" type="text" required minLength="2" maxLength="100"
                        value=${name} onInput=${e=>setName(e.target.value)} />
                    </${Field}>
                    <${Field} label="Email"><p class="static">${user.email}</p></${Field}>
                    <${Field} label="Role"><p class="static" style=${{textTransform:"capitalize"}}>${user.role}</p></${Field}>
                    <${Field} label="Department">
                      <select aria-label="Department" class="in" value=${dept} onChange=${e=>setDept(e.target.value)}>
                        ${deptList(state).map(d=>html`<option key=${d} value=${d}>${d}</option>`)}
                      </select>
                    </${Field}>
                    <${Field} label="Student ID" hint="Exactly 12 numbers — digits only">
                      <input aria-label="Student ID" class="in" type="text" inputMode="numeric" required
                        minLength="12" maxLength="12" placeholder="Example: 0272XXXXXXXX"
                        value=${studentId} onInput=${e=>setStudentId(e.target.value.replace(/[^0-9]/g,"").slice(0,12))} />
                    </${Field}>
                    <${Field} label="Phone number" hint="10 to 15 digits">
                      <input aria-label="Phone number" class="in" type="tel" inputMode="numeric" required
                        minLength="10" maxLength="15" placeholder="Example: 01712345678"
                        value=${phone} onInput=${e=>setPhone(e.target.value.replace(/[^0-9]/g,"").slice(0,15))} />
                    </${Field}>
                    <button class="btn-ink" type="submit">Save profile</button>
                  </form>
                </section>
                <section class="card p8">
                  <h2 class="sec-h2">Change password</h2>
                  ${passMsg && html`<${AlertBox} kind=${passMsg.kind}>${passMsg.text}</${AlertBox}>`}
                  <form onSubmit=${changePw}>
                    <${PasswordInput} label="Current password" value=${cur}
                      onInput=${e=>setCur(e.target.value)} autoComplete="current-password" required />
                    <div class="split2">
                      <${PasswordInput} label="New password" value=${npw}
                        onInput=${e=>setNpw(e.target.value)} autoComplete="new-password" required minLength=${8} />
                      <${PasswordInput} label="Confirm" value=${npw2}
                        onInput=${e=>setNpw2(e.target.value)} autoComplete="new-password" required />
                    </div>
                    <button class="btn-ink" type="submit">Change password</button>
                  </form>
                </section>
              </div>
              <section class="card p8">
                <h2 class="sec-h2">My bookmarks</h2>
                ${myBookmarks.length===0
                  ? html`<p style=${{color:"var(--dim)",margin:0}}>No bookmarks yet. Open a note and tap <b>Bookmark</b> to save it here.</p>`
                  : html`<ul class="rows">
                      ${myBookmarks.map(n=>{
                        const c = state.courses.find(cc=>cc.id===n.courseId);
                        return html`<li class="row-item" key=${n.id}>
                          <${FileBadge} type=${fileTypeOf(n)} />
                          <button class="row-main" onClick=${()=>go("note", n.id)}>
                            <b>${n.title}</b>
                            <small>${c ? c.code+" · Semester "+c.sem : ""}</small>
                          </button>
                        </li>`;
                      })}
                    </ul>`}
              </section>
            </div>

            <section class="card p8">
              <h2 class="sec-h2">My uploads</h2>
              ${myNotes.length===0
                ? html`<p style=${{color:"var(--dim)",margin:0}}>You have not uploaded any notes yet.
                    <button style=${{fontWeight:600,color:"var(--ink)",textDecoration:"underline"}} onClick=${()=>go("upload")}>Upload your first note</button></p>`
                : html`<ul class="rows">
                    ${myNotes.map(n=>{
                      const c = state.courses.find(cc=>cc.id===n.courseId);
                      return html`<li class="row-item" key=${n.id}>
                        <${FileBadge} type=${fileTypeOf(n)} />
                        <button class="row-main" onClick=${()=>go("note", n.id)}>
                          <b>${n.title}</b>
                          <small>${c ? c.code : ""} · ${fmtDate(n.created)} · ${n.downloads} downloads</small>
                        </button>
                        <${StatusBadge} status=${n.status} />
                        <span style=${{display:"flex",gap:"8px"}}>
                          <button class="pb pb-o" aria-label=${"Edit "+n.title} onClick=${()=>setEditing(n)}>
                            <${Icon} name="pencil" size=${16} /> Edit
                          </button>
                          <button class="pb pb-danger" aria-label=${"Delete "+n.title} onClick=${()=>setDeleting(n)}>
                            <${Icon} name="trash" size=${16} /> Delete
                          </button>
                        </span>
                      </li>`;
                    })}
                  </ul>`}
            </section>
          </div>

          ${editing && html`<${EditNoteModal} state=${state} note=${editing} act=${act} toast=${toast}
            close=${()=>setEditing(null)} />`}
          ${deleting && html`<div class="modal-veil" onClick=${()=>setDeleting(null)}>
            <div class="modal" role="dialog" aria-modal="true" aria-label="Delete this note" onClick=${e=>e.stopPropagation()}>
              <h2>Delete this note?</h2>
              <p class="body">“${deleting.title}” will be deleted permanently, along with its ratings and comments.</p>
              <div class="actions">
                <button class="btn-ghost" onClick=${()=>setDeleting(null)}>Cancel</button>
                <button class="btn-danger" onClick=${async ()=>{ const r = await act.deleteNote(deleting.id); setDeleting(null); if(r.ok) toast("Note deleted."); else toast(r.error); }}>Delete note</button>
              </div>
            </div>
          </div>`}
        </div></div></div>`;
      }



      function EditNoteModal({ state, note, act, toast, close }){
        const course0 = state.courses.find(c=>c.id===note.courseId);
        const [dept,setDept] = useState(course0 ? course0.dept : "");
        const [sem,setSem] = useState(course0 ? String(course0.sem) : "");
        const [code,setCode] = useState(course0 ? course0.code : "");
        const [title,setTitle] = useState(course0 ? course0.title : "");
        const [noteTitle,setNoteTitle] = useState(note.title);
        const [desc,setDesc] = useState(note.desc);
        const [err,setErr] = useState("");
        const save = async e=>{
          e.preventDefault(); setErr("");
          const res = resolveCourse(state, dept, sem, code, title);
          if(res.error){ setErr(res.error); return; }
          if(!noteTitle.trim()){ setErr("Please give your note a title."); return; }
          const r = await act.editNote(note.id, { dept, sem, courseCode: cleanCode(code), courseTitle: title.trim(),
            title: noteTitle.trim(), desc: desc.trim() });
          if(!r.ok){ setErr(r.error); return; }
          toast("Note updated.");
          close();
        };
        return html`<div class="modal-veil" onClick=${close}>
          <div class="modal wide" role="dialog" aria-modal="true" aria-label="Edit note" onClick=${e=>e.stopPropagation()}>
            <div class="m-head">
              <h2>Edit note</h2>
              <button class="x-btn" aria-label="Close edit form" onClick=${close}><${Icon} name="x" size=${20} /></button>
            </div>
            ${err && html`<${AlertBox} kind="error">${err}</${AlertBox}>`}
            <form onSubmit=${save}>
              <${CourseFields} courses=${state.courses} departments=${deptList(state)}
                dept=${dept} setDept=${setDept} sem=${sem} setSem=${setSem}
                code=${code} setCode=${setCode} title=${title} setTitle=${setTitle} />
              <${Field} label="Title">
                <input aria-label="Title" class="in" type="text" required minLength="3" maxLength="150"
                  value=${noteTitle} onInput=${e=>setNoteTitle(e.target.value)} />
              </${Field}>
              <${Field} label="Description">
                <textarea aria-label="Description" class="in" rows="4" maxLength="2000"
                  value=${desc} onInput=${e=>setDesc(e.target.value)}></textarea>
              </${Field}>
              <div style=${{marginTop:"8px",display:"flex",justifyContent:"flex-end",gap:"12px"}}>
                <button class="btn-ghost" type="button" onClick=${close}>Cancel</button>
                <button class="btn-gold" type="submit">Save changes</button>
              </div>
            </form>
          </div>
        </div>`;
      }

      /* ================= Admin ================= */
            function Admin({ state, user, go, act, toast, initialTab }){
        const [tab,setTab] = useState(initialTab || "pending");
        const [deletingUser,setDeletingUser] = useState(null);
        const [suspendingUser,setSuspendingUser] = useState(null);
        const [deletingNotice,setDeletingNotice] = useState(null);
        const [rejectingUser,setRejectingUser] = useState(null);
        /* Notice form — used both to post a new notice and to edit one */
        const [noticeTitle,setNoticeTitle] = useState("");
        const [noticeBody,setNoticeBody] = useState("");
        const [noticePin,setNoticePin] = useState("normal");
        const [editingNotice,setEditingNotice] = useState(null);
        const [noticeMsg,setNoticeMsg] = useState(null);
        /* Add-staff form — a new moderator/admin, created straight from here */
        const [staffName,setStaffName] = useState("");
        const [staffEmail,setStaffEmail] = useState("");
        const [staffDept,setStaffDept] = useState("CSE");
        const [staffPw,setStaffPw] = useState("");
        const [staffRole,setStaffRole] = useState("moderator");
        const [staffMsg,setStaffMsg] = useState(null);
        /* Load the admin data (stats, all notes, users, approval queue) */
        useEffect(()=>{
          if(user && isStaffUser(user)) act.loadAdmin();
        },[user && user.id]);
        if(!user) return html`<div class="view"><div class="wrap"><div class="page">
          <${EmptyState} title="Staff only" body="Log in with an admin or moderator account to open the panel.">
            <div class="cta"><button class="btn-gold" onClick=${()=>go("login")}>Log in</button></div>
          </${EmptyState}>
        </div></div></div>`;
        if(!isStaffUser(user)) return html`<div class="view"><div class="wrap"><div class="page">
          <${EmptyState} title="Staff only" body=${"Your account ("+user.email+") does not have admin or moderator access. An admin can give you a role from the Users tab."} />
        </div></div></div>`;
        const isAdmin = isAdminUser(user);
        /* A moderator who somehow lands on an admin-only tab goes back to approvals */
        const activeTab = (!isAdmin && (tab==="users" || tab==="courses" || tab==="departments")) ? "pending" : tab;
        /* Open support tickets, for the Support tab label and the bell */
        const openTickets = (state.adminTickets||[]).filter(t=>t.status==="open").length;

        const allNotes = state.adminNotes.length ? state.adminNotes : state.notes;
        const published = allNotes.filter(n=>n.status==="approved");
        const pending = allNotes.filter(n=>n.status==="pending");
        const totalDownloads = allNotes.reduce((a,n)=>a+n.downloads,0);
        const suspendedCount = state.users.filter(u=>u.suspended).length;
        const pendingAccounts = state.pendingUsers.length;
        const notices = [...(state.notices||[])].sort((a,b)=> (b.pinned?1:0)-(a.pinned?1:0) || b.created-a.created);
        const courseOf = n => state.courses.find(cc=>cc.id===n.courseId);
        const userOf = n => state.users.find(x=>x.id===n.userId) || (n.uploader ? { name:n.uploader } : null);

        const startEditNotice = nc=>{
          setEditingNotice(nc); setNoticeTitle(nc.title); setNoticeBody(nc.body);
          setNoticePin(nc.important ? "important" : nc.pinned ? "pinned" : "normal"); setNoticeMsg(null);
        };
        const cancelEditNotice = ()=>{ setEditingNotice(null); setNoticeTitle(""); setNoticeBody(""); setNoticePin("normal"); setNoticeMsg(null); };
        const submitNotice = async e=>{
          e.preventDefault(); setNoticeMsg(null);
          if(!noticeTitle.trim()){ setNoticeMsg({kind:"error",text:"Give the notice a title."}); return; }
          if(!noticeBody.trim()){ setNoticeMsg({kind:"error",text:"Write the notice text."}); return; }
          let r;
          if(editingNotice){
            r = await act.editNotice(editingNotice.id, { title:noticeTitle.trim(), body:noticeBody.trim(),
              pinned: noticePin==="pinned", important: noticePin==="important" });
            if(r.ok) toast("Notice updated — it is live on the notice board.");
            else setNoticeMsg({kind:"error",text:r.error});
          } else {
            r = await act.addNotice({ title:noticeTitle.trim(), body:noticeBody.trim(),
              pinned: noticePin==="pinned", important: noticePin==="important" });
            if(r.ok) toast("Notice posted — everyone can see it on the Home notice board.");
            else setNoticeMsg({kind:"error",text:r.error});
          }
          if(r.ok) cancelEditNotice();
        };
        const tabList = [["pending","Approvals ("+(pending.length+pendingAccounts)+")"],["notes","All notes"],
            ["notices","Notices ("+notices.length+")"],
            ["support","Support"+(openTickets>0 ? " ("+openTickets+")" : "")]]
          .concat(isAdmin ? [["users","Users ("+state.users.length+")"],["courses","Courses"],["departments","Departments"]] : []);

        const doNoteStatus = async (id, status, msg)=>{
          const r = await act.setNoteStatus(id, status);
          if(r.ok) toast(msg); else toast(r.error);
        };
        const doDeleteNote = async (id)=>{
          const r = await act.deleteNote(id);
          if(r.ok) toast("Note deleted."); else toast(r.error);
        };
        const doApproveUser = async (u)=>{
          const r = await act.approveUser(u.id);
          if(r.ok) toast(u.name+" approved — they can log in now."); else toast(r.error);
        };

        return html`<div class="view"><div class="wrap"><div class="page">
          <div class="page-head">
            <h1>${isAdmin ? "Admin panel" : "Moderator panel"}</h1>
            <p>${isAdmin
              ? "Approve notes, post notices, give members a role, suspend accounts and keep the library clean."
              : "Approve notes, manage the library and post notices. Roles and suspensions are handled by an admin."}</p>
          </div>

          <div class="stat-grid">
            ${[
              { value: published.length, label:"Published notes" },
              { value: pending.length, label:"Waiting for approval" },
              { value: isAdmin ? state.users.length : notices.length, label: isAdmin ? "Registered users" : "Notices posted" },
              { value: isAdmin ? suspendedCount : totalDownloads, label: isAdmin ? "Suspended users" : "Total downloads" },
              ...(isAdmin ? [{ value: pendingAccounts, label:"Accounts waiting approval" }] : [])
            ].map(s=>html`<div class="stat-card" key=${s.label}><b><${CountUp} value=${s.value} /></b><span>${s.label}</span></div>`)}
          </div>

          <div class="tabs" role="tablist" aria-label="Admin sections">
            ${tabList.map(([k,l])=>
              html`<button key=${k} role="tab" aria-selected=${activeTab===k} class=${activeTab===k ? "on" : ""} onClick=${()=>setTab(k)}>${l}</button>`)}
          </div>

          ${activeTab==="pending" && html`<section class="card p8 admin-sec">
            ${pendingAccounts>0 && html`<div style=${{margin:"0 0 24px"}}>
              <h3 style=${{fontSize:"18px",margin:"0 0 12px"}}>New accounts waiting for approval (${pendingAccounts})</h3>
              <ul class="rows">
                ${state.pendingUsers.map(u=>html`<li class="row-item" key=${u.id}>
                  <${Avatar} user=${u} cls="avatar lg" />
                  <button class="row-main" onClick=${()=>go("contributor", u.id)} title=${"Review "+u.name+"'s account"}>
                    <b>${u.name}</b>
                    <small>${u.email}${u.studentId ? " · ID "+u.studentId : ""}${u.phone ? " · "+u.phone : ""} · ${u.dept || "—"} · joined ${fmtDate(u.joined)}</small>
                  </button>
                  <span style=${{display:"flex",gap:"8px"}}>
                    <button class="pb pb-o" onClick=${()=>go("contributor", u.id)}>Review</button>
                    <button class="pb pb-approve" onClick=${()=>doApproveUser(u)}>Approve</button>
                    <button class="pb pb-reject" onClick=${()=>setRejectingUser(u)}>Reject</button>
                  </span>
                </li>`)}
              </ul>
            </div>`}
            <h2>Notes waiting for approval</h2>
            ${pending.length===0
              ? html`<p style=${{color:"var(--dim)",margin:0}}>Nothing is waiting. Every upload has been reviewed.</p>`
              : html`<ul class="rows">
                  ${pending.map(n=>{
                    const c = courseOf(n); const u = userOf(n);
                    return html`<li class="row-item" key=${n.id}>
                      <${FileBadge} type=${fileTypeOf(n)} />
                      <button class="row-main" onClick=${()=>go("note", n.id)}>
                        <b>${n.title}</b>
                        <small>${c ? c.code : ""} · by ${u ? u.name : "Unknown"} · ${fmtDate(n.created)}</small>
                      </button>
                      <span style=${{display:"flex",gap:"8px"}}>
                        <button class="pb pb-approve" onClick=${()=>doNoteStatus(n.id,"approved","Note approved.")}>Approve</button>
                        <button class="pb pb-reject" onClick=${()=>doNoteStatus(n.id,"rejected","Note rejected.")}>Reject</button>
                      </span>
                    </li>`;
                  })}
                </ul>`}
          </section>`}

          ${activeTab==="notes" && html`<section class="card p8 admin-sec">
            <h2>All notes</h2>
            ${allNotes.length===0
              ? html`<p style=${{color:"var(--dim)",margin:0}}>No notes in the library yet.</p>`
              : html`<ul class="rows">
                  ${allNotes.map(n=>{
                    const c = courseOf(n); const u = userOf(n);
                    return html`<li class="row-item" key=${n.id}>
                      <${FileBadge} type=${fileTypeOf(n)} />
                      <button class="row-main" onClick=${()=>go("note", n.id)}>
                        <b>${n.title}</b>
                        <small>${c ? c.code : ""} · by ${u ? u.name : "Unknown"} · ${n.downloads} downloads</small>
                      </button>
                      <${StatusBadge} status=${n.status} />
                      <span style=${{display:"flex",flexWrap:"wrap",gap:"8px"}}>
                        ${n.status!=="approved"
                          ? html`<button class="pb pb-o" onClick=${()=>doNoteStatus(n.id,"approved","Note approved.")}>Approve</button>`
                          : html`<button class="pb pb-o" onClick=${()=>doNoteStatus(n.id,"pending","Note sent back to pending.")}>Unpublish</button>`}
                        ${n.status!=="rejected" &&
                          html`<button class="pb pb-o" onClick=${()=>doNoteStatus(n.id,"rejected","Note rejected.")}>Reject</button>`}
                        <button class="pb pb-danger" aria-label=${"Delete "+n.title}
                          onClick=${()=>doDeleteNote(n.id)}>
                          <${Icon} name="trash" size=${16} /> Delete
                        </button>
                      </span>
                    </li>`;
                  })}
                </ul>`}
          </section>`}

          ${activeTab==="notices" && html`<div style=${{display:"grid",gap:"24px",alignItems:"start"}}>
            <section class="card p8 admin-sec">
              <h2>${editingNotice ? "Edit notice" : "Post a notice"}</h2>
              <p style=${{margin:"0 0 16px",fontSize:"15px",color:"var(--dim)"}}>Notices appear on the Home notice board for every visitor, and the newest ones also show in the notification bell. Pin a notice to keep it at the top.</p>
              ${noticeMsg && html`<${AlertBox} kind=${noticeMsg.kind}>${noticeMsg.text}</${AlertBox}>`}
              <form onSubmit=${submitNotice}>
                <${Field} label="Notice title">
                  <input aria-label="Notice title" class="in" type="text" required maxLength="120"
                    placeholder="Example: Library hours during exam week" value=${noticeTitle}
                    onInput=${e=>setNoticeTitle(e.target.value)} />
                </${Field}>
                <${Field} label="Notice text">
                  <textarea aria-label="Notice text" class="in" rows="4" required maxLength="1000"
                    placeholder="Write the announcement for all students…" value=${noticeBody}
                    onInput=${e=>setNoticeBody(e.target.value)}></textarea>
                </${Field}>
                <${Field} label="Placement">
                  <select aria-label="Notice placement" class="in" value=${noticePin} onChange=${e=>setNoticePin(e.target.value)}>
                    <option value="normal">Normal — in date order</option>
                    <option value="pinned">Pinned — stays at the top of the board</option>
                    <option value="important">Important — banner under the header after login</option>
                  </select>
                </${Field}>
                <div style=${{display:"flex",flexWrap:"wrap",gap:"10px"}}>
                  <button class="btn-gold" type="submit"><${Icon} name="megaphone" size=${17} /> ${editingNotice ? "Save notice" : "Post notice"}</button>
                  ${editingNotice && html`<button class="btn-ghost" type="button" onClick=${cancelEditNotice}>Cancel editing</button>`}
                </div>
              </form>
            </section>
            <section class="card p8 admin-sec">
              <h2>All notices (${notices.length})</h2>
              ${notices.length===0
                ? html`<p style=${{color:"var(--dim)",margin:0}}>No notices yet. Post the first one with the form above.</p>`
                : html`<ul class="rows">
                    ${notices.map(nc=>{
                      const by = state.users.find(u=>u.id===nc.authorId) || (nc.author ? { name:nc.author } : null);
                      return html`<li class="row-item" key=${nc.id}>
                        <span class="file-badge" aria-hidden="true"><${Icon} name="megaphone" size=${18} /></span>
                        <span class="row-main">
                          <b style=${{whiteSpace:"normal"}}>${nc.title}</b>
                          <small>${fmtDate(nc.created)}${by ? " · by "+by.name : ""}</small>
                          <span class="notice-row-body">${nc.body}</span>
                        </span>
                        ${nc.pinned && html`<span class="badge-pinned"><${Icon} name="pin" size=${13} /> Pinned</span>`}
                        ${nc.important && html`<span class="badge-important">Important</span>`}
                        <span class="user-controls">
                          <button class="pb pb-o" onClick=${async ()=>{ const r = await act.toggleNoticePin(nc.id); if(r.ok) toast(nc.pinned ? "Notice unpinned." : "Notice pinned to the top."); else toast(r.error); }}>${nc.pinned ? "Unpin" : "Pin"}</button>
                          <button class="pb pb-o" onClick=${async ()=>{ const r = await act.toggleNoticeImportant(nc.id); if(r.ok) toast(nc.important ? "Notice is no longer important." : "Notice marked important — it shows as a banner for logged-in members."); else toast(r.error); }}>${nc.important ? "Unmark important" : "Mark important"}</button>
                          <button class="pb pb-o" aria-label=${"Edit notice "+nc.title} onClick=${()=>startEditNotice(nc)}><${Icon} name="pencil" size=${15} /> Edit</button>
                          <button class="pb pb-danger" aria-label=${"Delete notice "+nc.title} onClick=${()=>setDeletingNotice(nc)}><${Icon} name="trash" size=${15} /> Delete</button>
                        </span>
                      </li>`;
                    })}
                  </ul>`}
            </section>
          </div>`}

          ${activeTab==="users" && isAdmin && html`<section class="card p8 admin-sec">
            <h2>Users — roles &amp; suspensions</h2>
            <p style=${{margin:"0 0 16px",fontSize:"15px",color:"var(--dim)"}}>Give a member a new role with the dropdown, or add a brand-new moderator or admin below — so one person does not have to manage everything. A suspended account cannot log in until you unsuspend it. You cannot change or suspend your own account.</p>
            ${pendingAccounts>0 && html`<div style=${{margin:"0 0 24px"}}>
              <h3 style=${{fontSize:"18px",margin:"0 0 12px"}}>New accounts waiting for approval (${pendingAccounts})</h3>
              <ul class="rows">
                ${state.pendingUsers.map(u=>html`<li class="row-item" key=${u.id}>
                  <${Avatar} user=${u} cls="avatar lg" />
                  <button class="row-main" onClick=${()=>go("contributor", u.id)} title=${"Review "+u.name+"'s account"}>
                    <b>${u.name}</b>
                    <small>${u.email}${u.studentId ? " · ID "+u.studentId : ""}${u.phone ? " · "+u.phone : ""} · ${u.dept || "—"} · joined ${fmtDate(u.joined)}</small>
                  </button>
                  <span style=${{display:"flex",gap:"8px"}}>
                    <button class="pb pb-o" onClick=${()=>go("contributor", u.id)}>Review</button>
                    <button class="pb pb-approve" onClick=${()=>doApproveUser(u)}>Approve</button>
                    <button class="pb pb-reject" onClick=${()=>setRejectingUser(u)}>Reject</button>
                  </span>
                </li>`)}
              </ul>
            </div>`}
            <form class="card p8" style=${{margin:"0 0 24px",background:"var(--cream)"}} onSubmit=${async e=>{ e.preventDefault(); setStaffMsg(null);
              if(staffName.trim().length<2){ setStaffMsg({kind:"error",text:"Please enter the person's full name."}); return; }
              if(state.users.some(u=>u.email.toLowerCase()===staffEmail.trim().toLowerCase())){ setStaffMsg({kind:"error",text:"An account with this email already exists — change their role in the list below instead."}); return; }
              const r = await act.addStaff({ name:staffName.trim(), email:staffEmail.trim(), dept:staffDept, password:staffPw, role:staffRole });
              if(!r.ok){ setStaffMsg({kind:"error",text:r.error}); return; }
              toast(staffName.trim()+" added as "+(staffRole==="admin" ? "an admin" : "a moderator")+". They can log in right away.");
              setStaffName(""); setStaffEmail(""); setStaffDept("CSE"); setStaffPw(""); setStaffRole("moderator"); }}>
              <h3 style=${{fontSize:"18px",margin:"0 0 4px"}}>Add a moderator or admin</h3>
              <p style=${{color:"var(--dim)",margin:"0 0 16px",fontSize:"14px"}}>They can log in right away with the email and password you set — no need to register first.</p>
              ${staffMsg && html`<${AlertBox} kind=${staffMsg.kind}>${staffMsg.text}</${AlertBox}>`}
              <${Field} label="Full name">
                <input aria-label="Staff full name" class="in" type="text" required minLength="2" maxLength="100"
                  placeholder="Example: Mim Akter" value=${staffName} onInput=${e=>setStaffName(e.target.value)} />
              </${Field}>
              <${Field} label="Email">
                <input aria-label="Staff email" class="in" type="email" required
                  placeholder="name@city.edu" value=${staffEmail} onInput=${e=>setStaffEmail(e.target.value)} />
              </${Field}>
              <${Field} label="Department">
                <select aria-label="Staff department" class="in" value=${staffDept} onChange=${e=>setStaffDept(e.target.value)}>
                  ${deptList(state).map(d=>html`<option key=${d} value=${d}>${d}</option>`)}
                </select>
              </${Field}>
              <${PasswordInput} label="Password" placeholder="At least 8 characters" value=${staffPw}
                onInput=${e=>setStaffPw(e.target.value)} autoComplete="new-password" required minLength=${8} />
              <${Field} label="Role">
                <select aria-label="Staff role" class="in" value=${staffRole} onChange=${e=>setStaffRole(e.target.value)}>
                  <option value="moderator">Moderator — approve notes, delete notes/comments, post notices</option>
                  <option value="admin">Admin — everything, including users and courses</option>
                </select>
              </${Field}>
              <button class="btn-ink" type="submit">Add staff member</button>
            </form>
            <ul class="rows">
              ${state.users.map(u=>{
                const isSelf = u.id===user.id;
                return html`<li class=${"row-item"+(u.suspended ? " is-suspended" : "")} key=${u.id}>
                <${Avatar} user=${u} cls="avatar lg" />
                <button class="row-main" onClick=${()=>go("contributor", u.id)} title=${"View "+u.name+"'s profile"}>
                  <b>${u.name}</b>
                  <small>${u.email}${u.studentId ? " · ID "+u.studentId : ""}${u.phone ? " · "+u.phone : ""} · joined ${fmtDate(u.joined)} · ${u.notes!==undefined ? u.notes : state.notes.filter(n=>n.userId===u.id).length} notes</small>
                </button>
                <span class=${"badge-role "+u.role}>${u.role}</span>
                <span class="badge-role">${u.dept || "—"}</span>
                ${u.suspended && html`<span class="badge-suspended">Suspended</span>`}
                ${u.approved===false && html`<span class="badge-suspended">Waiting for approval</span>`}
                ${isSelf
                  ? html`<span style=${{fontSize:"14px",color:"var(--dim)"}}>You</span>`
                  : html`<span class="user-controls">
                      ${u.approved===false && html`<button class="pb pb-o" onClick=${()=>go("contributor", u.id)}>Review</button>`}
                      <select class="role-select" aria-label=${"Role for "+u.name} value=${u.role}
                        onChange=${async e=>{ const r = e.target.value; const res = await act.setUserRole(u.id, r); if(res.ok) toast(u.name+" is now "+(r==="admin" ? "an admin" : r==="moderator" ? "a moderator" : "a student")+"."); else toast(res.error); }}>
                        <option value="student">Student</option>
                        <option value="moderator">Moderator</option>
                        <option value="admin">Admin</option>
                      </select>
                      ${u.suspended
                        ? html`<button class="pb pb-unsuspend" aria-label=${"Unsuspend "+u.name} onClick=${async ()=>{ const res = await act.setUserSuspended(u.id, false); if(res.ok) toast(u.name+" has been unsuspended and can log in again."); else toast(res.error); }}>
                            <${Icon} name="check" size=${15} /> Unsuspend
                          </button>`
                        : html`<button class="pb pb-suspend" aria-label=${"Suspend "+u.name} onClick=${()=>setSuspendingUser(u)}>
                            <${Icon} name="ban" size=${15} /> Suspend
                          </button>`}
                      <button class="pb pb-danger" aria-label=${"Delete user "+u.name} onClick=${()=>setDeletingUser(u)}>
                        <${Icon} name="trash" size=${16} /> Delete
                      </button>
                    </span>`}
              </li>`;})}
            </ul>
          </section>`}

          ${activeTab==="courses" && isAdmin && html`<${AdminCourses} state=${state} act=${act} toast=${toast} />`}

          ${activeTab==="departments" && isAdmin && html`<${AdminDepartments} state=${state} act=${act} toast=${toast} />`}

          ${activeTab==="support" && html`<${AdminSupport} state=${state} user=${user} act=${act} toast=${toast} />`}

          ${deletingUser && html`<div class="modal-veil" onClick=${()=>setDeletingUser(null)}>
            <div class="modal" role="dialog" aria-modal="true" aria-label="Delete this user" onClick=${e=>e.stopPropagation()}>
              <h2>Delete this user?</h2>
              <p class="body">${deletingUser.name} and everything they uploaded, rated and commented will be deleted permanently.</p>
              <div class="actions">
                <button class="btn-ghost" onClick=${()=>setDeletingUser(null)}>Cancel</button>
                <button class="btn-danger" onClick=${async ()=>{ const r = await act.deleteUser(deletingUser.id); setDeletingUser(null); if(r.ok) toast("User deleted."); else toast(r.error); }}>Delete user</button>
              </div>
            </div>
          </div>`}

          ${suspendingUser && html`<div class="modal-veil" onClick=${()=>setSuspendingUser(null)}>
            <div class="modal" role="dialog" aria-modal="true" aria-label="Suspend this user" onClick=${e=>e.stopPropagation()}>
              <h2>Suspend ${suspendingUser.name}?</h2>
              <p class="body">They will not be able to log in or use the portal until you unsuspend them from the Users tab. Their notes, ratings and comments stay as they are — suspension is not deletion, and you can undo it any time.</p>
              <div class="actions">
                <button class="btn-ghost" onClick=${()=>setSuspendingUser(null)}>Cancel</button>
                <button class="btn-danger" onClick=${async ()=>{ const r = await act.setUserSuspended(suspendingUser.id, true); setSuspendingUser(null); if(r.ok) toast(suspendingUser.name+" has been suspended."); else toast(r.error); }}>Suspend account</button>
              </div>
            </div>
          </div>`}

          ${rejectingUser && html`<div class="modal-veil" onClick=${()=>setRejectingUser(null)}>
            <div class="modal" role="dialog" aria-modal="true" aria-label="Reject this sign-up" onClick=${e=>e.stopPropagation()}>
              <h2>Reject this sign-up?</h2>
              <p class="body">${rejectingUser.name}'s account will be deleted permanently.</p>
              <div class="actions">
                <button class="btn-ghost" onClick=${()=>setRejectingUser(null)}>Cancel</button>
                <button class="btn-danger" onClick=${async ()=>{ const r = await act.rejectUser(rejectingUser.id); setRejectingUser(null); if(r.ok) toast("Sign-up rejected — the account was removed."); else toast(r.error); }}>Reject sign-up</button>
              </div>
            </div>
          </div>`}

          ${deletingNotice && html`<div class="modal-veil" onClick=${()=>setDeletingNotice(null)}>
            <div class="modal" role="dialog" aria-modal="true" aria-label="Delete this notice" onClick=${e=>e.stopPropagation()}>
              <h2>Delete this notice?</h2>
              <p class="body">“${deletingNotice.title}” will be removed from the notice board for everyone.</p>
              <div class="actions">
                <button class="btn-ghost" onClick=${()=>setDeletingNotice(null)}>Cancel</button>
                <button class="btn-danger" onClick=${async ()=>{ const r = await act.deleteNotice(deletingNotice.id); if(editingNotice && editingNotice.id===deletingNotice.id) cancelEditNotice(); setDeletingNotice(null); if(r.ok) toast("Notice deleted."); else toast(r.error); }}>Delete notice</button>
              </div>
            </div>
          </div>`}
        </div></div></div>`;
      }

      /* Departments are stored in the database, not hard-coded. An admin
         adds a new one, renames one (the new name follows into every
         course and member in it), or removes one — removal is refused
         while courses or members still use it. */
      function AdminDepartments({ state, act, toast }){
        const [name,setName] = useState("");
        const [msg,setMsg] = useState(null);
        const [busy,setBusy] = useState(false);
        const [renaming,setRenaming] = useState(null);
        const [renameVal,setRenameVal] = useState("");
        const [deleting,setDeleting] = useState(null);
        useEffect(()=>{ act.loadAdminDepartments(); },[]);
        /* The admin list carries each department's id (rename/remove need
           it) and its course/member counts; fall back to the public names
           while it loads. */
        const depts = (state.adminDepartments && state.adminDepartments.length)
          ? state.adminDepartments
          : deptList(state).map(d=>({ id:null, name:d,
              courses: state.courses.filter(c=>c.dept===d).length,
              members: state.users.filter(u=>u.dept===d).length }));
        const submit = async e=>{
          e.preventDefault(); setMsg(null);
          if(name.trim().length<2){ setMsg({kind:"error",text:"Give the department a name."}); return; }
          setBusy(true);
          const r = await act.addDepartment(name.trim());
          setBusy(false);
          if(!r.ok){ setMsg({kind:"error",text:r.error}); return; }
          setName("");
          setMsg({kind:"success",text:"Department added."});
        };
        const doRename = async ()=>{
          if(renameVal.trim().length<2){ toast("Give the department a name."); return; }
          const r = await act.renameDepartment(renaming.id, renameVal.trim());
          if(!r.ok){ toast(r.error); return; }
          toast("Department renamed — courses and members follow the new name.");
          setRenaming(null);
        };
        const doDelete = async ()=>{
          const r = await act.deleteDepartment(deleting.id);
          setDeleting(null);
          if(!r.ok){ toast(r.error); return; }
          toast("Department removed.");
        };
        return html`<section class="card p8 admin-sec">
          <h2>Departments</h2>
          <p style=${{margin:"0 0 16px",fontSize:"15px",color:"var(--dim)"}}>Departments live in the database. Adding one here makes it appear in the upload form, the register form and the notes filters. Renaming one updates every course and member in it. A department with courses or members cannot be removed.</p>
          ${msg && html`<${AlertBox} kind=${msg.kind}>${msg.text}</${AlertBox}>`}
          <form onSubmit=${submit} style=${{display:"flex",flexWrap:"wrap",gap:"10px",alignItems:"end",marginBottom:"20px"}}>
            <div style=${{flex:"1 1 240px"}}>
              <${Field} label="New department">
                <input aria-label="New department" class="in" type="text" required maxLength="80"
                  placeholder="Example: Pharmacy" value=${name} onInput=${e=>setName(e.target.value)} />
              </${Field}>
            </div>
            <button class="btn-ink" type="submit" disabled=${busy}>Add department</button>
          </form>
          <ul class="rows">
            ${depts.map(d=>html`<li class="row-item" key=${d.id || d.name}>
              <span class="file-badge" aria-hidden="true"><${Icon} name="building" size=${18} /></span>
              <span class="row-main">
                <b>${d.name}</b>
                <small>${d.courses} ${d.courses===1 ? "course" : "courses"} · ${d.members} ${d.members===1 ? "member" : "members"}</small>
              </span>
              ${renaming && renaming.id===d.id
                ? html`<span style=${{display:"flex",flexWrap:"wrap",gap:"8px",alignItems:"center"}}>
                    <input aria-label=${"Rename "+d.name} class="in" type="text" maxLength="80" value=${renameVal}
                      onInput=${e=>setRenameVal(e.target.value)} style=${{width:"180px"}} />
                    <button class="pb pb-approve" onClick=${doRename}>Save</button>
                    <button class="pb pb-o" onClick=${()=>setRenaming(null)}>Cancel</button>
                  </span>`
                : html`<span style=${{display:"flex",gap:"8px"}}>
                    <button class="pb pb-o" aria-label=${"Rename "+d.name} disabled=${!d.id}
                      onClick=${()=>{ setRenaming(d); setRenameVal(d.name); }}>
                      <${Icon} name="pencil" size=${15} /> Rename
                    </button>
                    <button class="pb pb-danger" aria-label=${"Remove "+d.name} disabled=${!d.id}
                      onClick=${()=>setDeleting(d)}>
                      <${Icon} name="trash" size=${15} /> Remove
                    </button>
                  </span>`}
            </li>`)}
          </ul>
          ${deleting && html`<div class="modal-veil" onClick=${()=>setDeleting(null)}>
            <div class="modal" role="dialog" aria-modal="true" aria-label="Remove this department" onClick=${e=>e.stopPropagation()}>
              <h2>Remove “${deleting.name}”?</h2>
              <p class="body">The department will be removed from the lists. If it still has courses or members, the removal will be refused.</p>
              <div class="actions">
                <button class="btn-ghost" onClick=${()=>setDeleting(null)}>Cancel</button>
                <button class="btn-danger" onClick=${doDelete}>Remove department</button>
              </div>
            </div>
          </div>`}
        </section>`;
      }

      /* Staff support inbox: every open ticket, with the member's thread.
         Replying marks the ticket answered; a member reply re-opens it. */
      function AdminSupport({ state, user, act, toast }){
        const [sel,setSel] = useState(null);
        const [thread,setThread] = useState(null);
        const [reply,setReply] = useState("");
        const [busy,setBusy] = useState(false);
        useEffect(()=>{ act.loadAdminTickets(); },[]);
        const tickets = [...(state.adminTickets||[])].sort((a,b)=>b.updated-a.updated);
        const open = async t=>{
          setSel(t); setThread(null);
          const r = await act.loadAdminTicket(t.id);
          if(r.ok) setThread(r.data); else toast(r.error);
        };
        const sendReply = async e=>{
          e.preventDefault();
          if(!reply.trim()) return;
          setBusy(true);
          const r = await act.addAdminTicketReply(sel.id, reply.trim());
          setBusy(false);
          if(!r.ok){ toast(r.error); return; }
          setReply("");
          const d = await act.loadAdminTicket(sel.id);
          if(d.ok) setThread(d.data);
        };
        const statusLabel = s => s==="open" ? "Open" : s==="answered" ? "Answered" : "Closed";
        return html`<section class="card p8 admin-sec">
          <h2>Support tickets</h2>
          ${tickets.length===0
            ? html`<p style=${{color:"var(--dim)",margin:0}}>No support tickets yet. When a member asks for help, their ticket appears here.</p>`
            : html`<div class="support-grid">
                <ul class="rows">
                  ${tickets.map(t=>html`<li class=${"row-item"+(sel && sel.id===t.id ? " selected" : "")} key=${t.id}>
                    <span class="file-badge" aria-hidden="true"><${Icon} name="user" size=${18} /></span>
                    <button class="row-main" onClick=${()=>open(t)}>
                      <b>${t.subject}</b>
                      <small>${t.userName||"a member"} · ${t.type} · ${fmtDate(t.created)} · ${t.replyCount} ${t.replyCount===1 ? "reply" : "replies"}</small>
                    </button>
                    <span class=${"badge-status "+t.status}>${statusLabel(t.status)}</span>
                  </li>`)}
                </ul>
                <div>
                  ${!sel
                    ? html`<p style=${{color:"var(--dim)",margin:0}}>Pick a ticket to read it and reply.</p>`
                    : !thread
                    ? html`<p style=${{color:"var(--dim)",margin:0}}>Loading the ticket…</p>`
                    : html`<div>
                        <div style=${{display:"flex",flexWrap:"wrap",alignItems:"center",gap:"10px"}}>
                          <h3 style=${{margin:0,flex:"1 1 240px"}}>${thread.ticket.subject}</h3>
                          <span class=${"badge-status "+thread.ticket.status}>${statusLabel(thread.ticket.status)}</span>
                        </div>
                        <p style=${{color:"var(--dim)",fontSize:"14px",margin:"8px 0 0"}}>${thread.ticket.userName||"a member"} · ${thread.ticket.type} · opened ${fmtDate(thread.ticket.created)}</p>
                        <p style=${{margin:"16px 0 0",whiteSpace:"pre-wrap"}}>${thread.ticket.details}</p>
                        <div class="ticket-thread">
                          ${thread.replies.map(rp=>html`<div class="comment-row" key=${rp.id}>
                            <${Avatar} user=${rp} />
                            <div style=${{minWidth:0}}>
                              <span class="nm">${rp.name}</span>
                              <span class="dt">${fmtDate(rp.created)}${(rp.role==="admin" || rp.role==="moderator") ? " · staff" : ""}</span>
                              <p class="tx">${rp.body}</p>
                            </div>
                          </div>`)}
                        </div>
                        ${thread.ticket.status!=="closed"
                          ? html`<form onSubmit=${sendReply} style=${{marginTop:"16px"}}>
                              <label class="sr" htmlFor="admin-ticket-reply">Write a reply</label>
                              <textarea id="admin-ticket-reply" class="in" rows="3" required maxLength="5000"
                                placeholder="Write your reply…" value=${reply}
                                onInput=${e=>setReply(e.target.value)}></textarea>
                              <div style=${{marginTop:"12px"}}>
                                <button class="btn-ink" type="submit" disabled=${busy || !reply.trim()}>Send reply</button>
                              </div>
                            </form>`
                          : html`<p style=${{color:"var(--dim)",margin:"16px 0 0"}}>This ticket is closed. The member can re-open it from their Support page.</p>`}
                      </div>`}
                </div>
              </div>`}
        </section>`;
      }

      function AdminCourses({ state, act, toast }){
        const [dept,setDept] = useState(""); const [sem,setSem] = useState("");
        const [code,setCode] = useState(""); const [title,setTitle] = useState("");
        const [msg,setMsg] = useState(null);
        /* Editing a course — a mistake in the catalogue can be fixed here,
           and notes linked to it show the corrected code and title. */
        const [editing,setEditing] = useState(null);
        const [edept,setEdept] = useState(""); const [esem,setEsem] = useState("");
        const [ecode,setEcode] = useState(""); const [etitle,setEtitle] = useState("");
        const [editMsg,setEditMsg] = useState(null);
        const sorted = useMemo(()=> [...state.courses].sort((a,b)=>
          a.dept.localeCompare(b.dept) || a.sem-b.sem || a.code.localeCompare(b.code)), [state.courses]);
        const add = async e=>{
          e.preventDefault(); setMsg(null);
          const res = resolveCourse(state, dept, sem, code, title);
          if(res.error){ setMsg({kind:"error",text:res.error}); return; }
          if(!res.created){ setMsg({kind:"error",text:"That course is already in the catalogue ("+res.course.code+" — "+res.course.title+")."}); return; }
          const r = await act.addCourse({ dept, sem, code: cleanCode(code), title: title.trim() });
          if(!r.ok){ setMsg({kind:"error",text:r.error}); return; }
          setCode(""); setTitle("");
          setMsg({kind:"success",text:"Course added."});
        };
        const del = async c=>{
          const used = state.notes.filter(n=>n.courseId===c.id).length;
          if(used){ toast("Cannot delete "+c.code+" — "+used+" note(s) are attached to it."); return; }
          const r = await act.deleteCourse(c.id);
          if(r.ok) toast("Course deleted."); else toast(r.error);
        };
        const startEdit = c=>{
          setEditing(c); setEdept(c.dept); setEsem(String(c.sem)); setEcode(c.code); setEtitle(c.title); setEditMsg(null);
        };
        const saveEdit = async e=>{
          e.preventDefault(); setEditMsg(null);
          const res = resolveCourse(state, edept, esem, ecode, etitle);
          if(res.error){ setEditMsg({kind:"error",text:res.error}); return; }
          /* Taking another course's code in the same department+semester
             is refused — but keeping this course's own code is fine. */
          if(!res.created && res.course.id!==editing.id){
            setEditMsg({kind:"error",text:"That course is already in the catalogue ("+res.course.code+" — "+res.course.title+")."}); return;
          }
          const r = await act.editCourse(editing.id, { dept:edept, sem:esem, code: cleanCode(ecode), title: etitle.trim() });
          if(!r.ok){ setEditMsg({kind:"error",text:r.error}); return; }
          toast("Course updated — notes linked to it show the corrected code and title.");
          setEditing(null);
        };
        return html`<div style=${{display:"grid",gap:"24px",alignItems:"start"}}>
          <section class="card p8 admin-sec">
            <h2>Add a course</h2>
            ${msg && html`<${AlertBox} kind=${msg.kind}>${msg.text}</${AlertBox}>`}
            <form onSubmit=${add}>
              <${CourseFields} grid=${true} courses=${state.courses} departments=${deptList(state)}
                dept=${dept} setDept=${setDept} sem=${sem} setSem=${setSem}
                code=${code} setCode=${setCode} title=${title} setTitle=${setTitle} />
              <button class="btn-ink" type="submit">Add course</button>
            </form>
          </section>
          ${editing && html`<section class="card p8 admin-sec">
            <h2>Edit course</h2>
            ${editMsg && html`<${AlertBox} kind=${editMsg.kind}>${editMsg.text}</${AlertBox}>`}
            <form onSubmit=${saveEdit}>
              <${CourseFields} grid=${true} courses=${state.courses} departments=${deptList(state)}
                dept=${edept} setDept=${setEdept} sem=${esem} setSem=${setEsem}
                code=${ecode} setCode=${setEcode} title=${etitle} setTitle=${setEtitle} />
              <div style=${{display:"flex",flexWrap:"wrap",gap:"10px"}}>
                <button class="btn-ink" type="submit">Save course</button>
                <button class="btn-ghost" type="button" onClick=${()=>setEditing(null)}>Cancel</button>
              </div>
            </form>
          </section>`}
          <section class="card p8 admin-sec">
            <h2>All courses</h2>
            <ul class="rows">
              ${sorted.map(c=>html`<li class="row-item" key=${c.id}>
                <span class="row-main">
                  <b style=${{whiteSpace:"normal"}}>${c.code} — ${c.title}</b>
                  <small>${c.dept} · Semester ${c.sem}</small>
                </span>
                <span style=${{display:"flex",gap:"8px"}}>
                  <button class="pb pb-o" aria-label=${"Edit course "+c.code} onClick=${()=>startEdit(c)}>
                    <${Icon} name="pencil" size=${15} /> Edit
                  </button>
                  <button class="pb pb-danger" aria-label=${"Delete course "+c.code} onClick=${()=>del(c)}>
                    <${Icon} name="trash" size=${16} /> Delete
                  </button>
                </span>
              </li>`)}
            </ul>
          </section>
        </div>`;
      }



      /* ================= App root ================= */
            function App(){
        const [state,setState] = useState(emptyState);
        const [view,setView] = useState("home");
        const [noteId,setNoteId] = useState(null);
        const [contributorId,setContributorId] = useState(null);
        const [browseSeed,setBrowseSeed] = useState({ q:"", dept:"" });
        const [focusNotice,setFocusNotice] = useState(null);
        const [supportTicketId,setSupportTicketId] = useState(null);
        const [adminTab,setAdminTab] = useState("pending");
        const [toastMsg,setToastMsg] = useState("");
        const toastTimer = useRef(null);
        const [loading,setLoading] = useState(true);
        const [bootError,setBootError] = useState("");
        const [theme,setTheme] = useState(()=>currentTheme());
        const meRef = useRef(null);
        meRef.current = state.me;

        const toggleTheme = ()=>{
          const next = theme==="dark" ? "light" : "dark";
          setTheme(next); applyTheme(next);
        };

        /* ---- Data loaders (all from the API) ---- */
        const loadPublic = async ()=>{
          const [coursesRes, noticesRes, notesRes, deptsRes] = await Promise.all([
            api("/courses"), api("/notices"), api("/notes"), api("/departments").catch(()=>({ departments:null }))
          ]);
          setState(s=>({ ...s,
            courses:(coursesRes.courses||[]).map(normCourse),
            notices:noticesRes.notices||[],
            notes:(notesRes.notes||[]).map(normNote),
            departments:(deptsRes.departments && deptsRes.departments.length ? deptsRes.departments : s.departments) }));
        };
        const loadUserData = async (me)=>{
          const jobs = [
            api("/my-notes").then(r=>setState(s=>({ ...s, myNotes:(r.notes||[]).map(normNote) }))),
            api("/bookmarks").then(r=>setState(s=>({ ...s, bookmarks:(r.notes||[]).map(n=>({ noteId:n.id })) }))),
            api("/support/tickets").then(r=>setState(s=>({ ...s, tickets:r.tickets||[] }))).catch(()=>{})
          ];
          if(isStaffUser(me)){
            jobs.push(api("/admin/notes").then(r=>setState(s=>({ ...s, adminNotes:(r.notes||[]).map(normNote) }))));
            jobs.push(api("/admin/stats").then(r=>setState(s=>({ ...s, stats:r }))));
            jobs.push(api("/admin/support/tickets").then(r=>setState(s=>({ ...s, adminTickets:r.tickets||[] }))).catch(()=>{}));
            if(isAdminUser(me)){
              jobs.push(api("/admin/users").then(r=>setState(s=>({ ...s, users:(r.users||[]).map(normUser) }))));
              jobs.push(api("/admin/users?approved=0").then(r=>setState(s=>({ ...s, pendingUsers:(r.users||[]).map(normUser) }))));
              jobs.push(api("/admin/departments").then(r=>setState(s=>({ ...s, adminDepartments:r.departments||[] }))).catch(()=>{}));
            }
          }
          await Promise.all(jobs);
        };
        const refreshAll = async ()=>{
          await loadPublic();
          if(meRef.current) await loadUserData(meRef.current);
        };
        const loadAdmin = async ()=>{
          if(meRef.current) await loadUserData(meRef.current);
        };

        /* First load: who is logged in, then the public library. */
        useEffect(()=>{
          (async ()=>{
            try{
              const meRes = await api("/me").catch(()=>({ user:null }));
              const me = meRes.user ? normUser(meRes.user) : null;
              await loadPublic();
              if(me){ setState(s=>({ ...s, me })); await loadUserData(me); }
              setLoading(false);
            }catch(e){
              setBootError(e.message || "Could not reach the server.");
              setLoading(false);
            }
          })();
        },[]);
        /* Scroll to the top on navigation — except when a notice was opened
           from the bell: the Notice Board then scrolls to that notice. */
        useEffect(()=>{
          if(view==="notices" && focusNotice) return;
          window.scrollTo({ top:0, behavior:"instant" in window ? "instant" : "auto" });
        },[view,noteId,contributorId,focusNotice]);

        /* Scroll reveal: blocks below the fold start hidden (.rv) and rise in
           (.rv-in, staggered) as they scroll into view. Blocks already on
           screen are never hidden, so nothing flashes or waits. */
        const revealIO = useRef(null);
        useLayoutEffect(()=>{
          const REVEAL_SEL = [".sec-head",".feat",".how-grid li",".lib-head",".note-card",".aud",
            ".gate",".campus-txt",".pano",".cta",".stat-card",".row-item",".card",".empty",
            ".doc-page",".comment-row",".bm-row",".trust",".notice-card",".notice-head"]
            .map(s=>s+":not([data-rvd])").join(",");
          const els = document.querySelectorAll(REVEAL_SEL);
          if(!els.length) return;
          if(REDUCED_MOTION || !("IntersectionObserver" in window)){
            els.forEach(el=>el.setAttribute("data-rvd","1"));
            return;
          }
          if(!revealIO.current){
            revealIO.current = new IntersectionObserver(entries=>{
              let i = 0;
              entries.forEach(en=>{
                if(!en.isIntersecting) return;
                const el = en.target;
                revealIO.current.unobserve(el);
                const d = Math.min(i++ * 90, 450);
                el.style.setProperty("--rvd", d+"ms");
                el.classList.add("rv-in");
                setTimeout(()=>{ el.classList.remove("rv","rv-in"); el.style.removeProperty("--rvd"); }, d+1000);
              });
            }, { threshold:0, rootMargin:"0px 0px -8% 0px" });
          }
          const vh = window.innerHeight;
          els.forEach(el=>{
            el.setAttribute("data-rvd","1");
            const r = el.getBoundingClientRect();
            if(r.top < vh*.95 && r.bottom > 0) return;
            el.classList.add("rv");
            revealIO.current.observe(el);
          });
        });

        const toast = useCallback(msg=>{
          setToastMsg(msg);
          if(toastTimer.current) clearTimeout(toastTimer.current);
          toastTimer.current = setTimeout(()=>setToastMsg(""), 3400);
        },[]);
        const go = useCallback((v, id, q, dept)=>{
          if(v==="browse") setBrowseSeed({ q:q||"", dept:dept||"" });
          if(v==="note") setNoteId(id);
          if(v==="contributor") setContributorId(id);
          if(v==="notices") setFocusNotice(id || null);
          if(v==="support") setSupportTicketId(id || null);
          if(v==="admin") setAdminTab(typeof id==="string" ? id : "pending");
          setView(v);
        },[]);
        const user = state.me;

        /* ---- Every action goes through the API. Each returns
               {ok:true, ...} or {ok:false, error:"..."} so the views can
               show the server's message. ---- */
        const act = {
          /* Auth */
          login: async (email, pw)=>{
            try{
              const r = await api("/login", { method:"POST", body:{ email, password:pw } });
              const me = normUser(r.user);
              setState(s=>({ ...s, me }));
              /* Notes are members-only: the anonymous library was empty,
                 so reload it now that the member is signed in. A hiccup
                 while reloading must NOT fail the login itself: the member
                 is already signed in, and if this step threw, the Login
                 page would stay put with "Please log in first." even
                 though the header already shows the member as signed in.
                 The page still navigates; the data loads on refresh. */
              try{ await loadPublic(); await loadUserData(me); }catch(e){}
              return { ok:true, user:me };
            }catch(e){ return { ok:false, error:e.message, code:e.code || null }; }
          },
          logout: async ()=>{
            try{ await api("/logout", { method:"POST" }); }catch(e){}
            setState(s=>({ ...s, me:null, myNotes:[], bookmarks:[], myRatings:{}, adminNotes:[], pendingUsers:[], stats:null, users:[], tickets:[], adminTickets:[], adminDepartments:[] }));
            await loadPublic();
            return { ok:true };
          },
          register: async (data)=>{
            try{
              const r = await api("/register", { method:"POST", body:data });
              return { ok:true, message:r.message, user:r.user ? normUser(r.user) : null,
                       needsVerification: !!r.needsVerification, email: r.email || data.email };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          /* Email verification: the 6-digit code sent to the new account */
          verifyEmail: async (email, code)=>{
            try{
              const r = await api("/verify-email", { method:"POST", body:{ email, code } });
              return { ok:true, message:r.message || "" };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          resendVerification: async (email)=>{
            try{
              const r = await api("/resend-verification", { method:"POST", body:{ email } });
              return { ok:true, message:r.message || "" };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          forgot: async (email)=>{
            try{
              const r = await api("/forgot", { method:"POST", body:{ email } });
              return { ok:true, code:r.code || null };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          resetPassword: async (email, code, pw)=>{
            try{
              await api("/reset", { method:"POST", body:{ email, code, password:pw } });
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          updateProfile: async (data)=>{
            try{
              const r = await api("/profile", { method:"PUT", body:data });
              const me = normUser(r.user);
              setState(s=>({ ...s, me }));
              return { ok:true, user:me };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          changePassword: async (cur, npw)=>{
            try{
              await api("/change-password", { method:"POST", body:{ oldPassword:cur, newPassword:npw } });
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          setPhoto: async (url)=>{
            /* PUT /api/profile is a full update: it validates name, dept,
               Student ID and phone, so send the saved profile values along
               with the new photo (or removePhoto). */
            try{
              const me = meRef.current;
              if(!me) return { ok:false, error:"Please log in first." };
              const body = { name:me.name, dept:me.dept, studentId:me.studentId, phone:me.phone };
              if(url===null) body.removePhoto = true; else body.photo = url;
              const r = await api("/profile", { method:"PUT", body });
              const nu = normUser(r.user);
              setState(s=>({ ...s, me:nu }));
              return { ok:true, user:nu };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          /* Notes */
          loadNoteDetail: async (id)=>{
            try{
              const r = await api("/notes/"+id);
              const note = normNote(r.note);
              setState(s=>{
                const notes = s.notes.some(n=>n.id===note.id)
                  ? s.notes.map(n=>n.id===note.id ? note : n) : [...s.notes, note];
                const myRatings = { ...s.myRatings };
                if(typeof r.myRating==="number") myRatings[note.id] = r.myRating;
                const comments = [...s.comments.filter(c=>c.noteId!==note.id),
                  ...(r.comments||[]).map(c=>({ ...c, noteId:note.id }))];
                const bookmarks = (r.bookmarked===true && !s.bookmarks.some(b=>b.noteId===note.id))
                  ? [...s.bookmarks, { noteId:note.id }] : s.bookmarks;
                return { ...s, notes, myRatings, comments, bookmarks };
              });
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          bumpDownloads: id=>{
            /* The server counts the download when the file link is opened;
               this just keeps the number on screen in sync. */
            setState(s=>({
              ...s,
              notes:s.notes.map(n=>n.id===id ? { ...n, downloads:(n.downloads||0)+1 } : n),
              myNotes:s.myNotes.map(n=>n.id===id ? { ...n, downloads:(n.downloads||0)+1 } : n),
              adminNotes:s.adminNotes.map(n=>n.id===id ? { ...n, downloads:(n.downloads||0)+1 } : n)
            }));
            return { ok:true };
          },
          rate: async (id, value)=>{
            try{
              const r = await api("/notes/"+id+"/rate", { method:"POST", body:{ value } });
              setState(s=>{
                const patchNote = n=>n.id===id ? { ...n, avg:r.avg, count:r.count } : n;
                return { ...s,
                  notes:s.notes.map(patchNote), myNotes:s.myNotes.map(patchNote),
                  adminNotes:s.adminNotes.map(patchNote),
                  myRatings:{ ...s.myRatings, [id]:value } };
              });
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          addComment: async (id, text)=>{
            try{
              await api("/notes/"+id+"/comments", { method:"POST", body:{ text } });
              await act.loadNoteDetail(id);
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          deleteComment: async (id)=>{
            try{
              await api("/comments/"+id, { method:"DELETE" });
              setState(s=>({ ...s, comments:s.comments.filter(c=>c.id!==id) }));
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          toggleBookmark: async (id)=>{
            try{
              const r = await api("/notes/"+id+"/bookmark", { method:"POST" });
              setState(s=>{
                const has = s.bookmarks.some(b=>b.noteId===id);
                return { ...s, bookmarks: r.bookmarked
                  ? (has ? s.bookmarks : [...s.bookmarks, { noteId:id }])
                  : s.bookmarks.filter(b=>b.noteId!==id) };
              });
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          addNote: async (data)=>{
            try{
              const r = await api("/notes", { method:"POST", body:{
                dept:data.dept, sem:semStr(data.sem), courseCode:data.courseCode, courseTitle:data.courseTitle,
                title:data.title, desc:data.desc, fileName:data.fileName, fileData:data.fileData } });
              await refreshAll();
              return { ok:true, id:r.id, status:r.status };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          editNote: async (id, data)=>{
            try{
              await api("/notes/"+id, { method:"PUT", body:{
                dept:data.dept, sem:semStr(data.sem), courseCode:data.courseCode, courseTitle:data.courseTitle,
                title:data.title, desc:data.desc } });
              await refreshAll();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          deleteNote: async (id)=>{
            try{
              await api("/notes/"+id, { method:"DELETE" });
              await refreshAll();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          /* Contributor profile */
          loadContributor: async (id)=>{
            try{
              const r = await api("/users/"+id);
              return { ok:true, data:r };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          /* Admin */
          loadAdmin,
          refreshAll,
          setNoteStatus: async (id, status)=>{
            try{
              await api("/admin/notes/"+id+"/status", { method:"POST", body:{ status } });
              await refreshAll();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          deleteUser: async (id)=>{
            try{
              await api("/admin/users/"+id, { method:"DELETE" });
              await loadAdmin();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          setUserRole: async (id, role)=>{
            try{
              await api("/admin/users/"+id+"/role", { method:"PUT", body:{ role } });
              await loadAdmin();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          setUserSuspended: async (id, suspended)=>{
            try{
              await api("/admin/users/"+id+"/suspend", { method:"PUT", body:{ suspended } });
              await loadAdmin();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          addStaff: async ({name, email, dept, password, role})=>{
            try{
              await api("/admin/users", { method:"POST", body:{ name, email, dept, password, role } });
              await loadAdmin();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          approveUser: async (id)=>{
            try{
              await api("/admin/users/"+id+"/approve", { method:"POST" });
              await loadAdmin();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          rejectUser: async (id)=>{
            try{
              await api("/admin/users/"+id+"/reject", { method:"POST" });
              await loadAdmin();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          addNotice: async ({title, body, pinned, important})=>{
            try{
              await api("/admin/notices", { method:"POST", body:{ title, body, pinned, important } });
              await loadPublic();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          editNotice: async (id, {title, body, pinned, important})=>{
            try{
              await api("/admin/notices/"+id, { method:"PUT", body:{ title, body, pinned, important } });
              await loadPublic();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          deleteNotice: async (id)=>{
            try{
              await api("/admin/notices/"+id, { method:"DELETE" });
              await loadPublic();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          toggleNoticePin: async (id)=>{
            try{
              const nc = (state.notices||[]).find(x=>x.id===id);
              if(!nc) return { ok:false, error:"Notice not found." };
              await api("/admin/notices/"+id, { method:"PUT", body:{ title:nc.title, body:nc.body, pinned:!nc.pinned, important: !!nc.important } });
              await loadPublic();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          /* Mark a notice important (or not): it then shows as a banner
             under the header for every logged-in member until dismissed. */
          toggleNoticeImportant: async (id)=>{
            try{
              const nc = (state.notices||[]).find(x=>x.id===id);
              if(!nc) return { ok:false, error:"Notice not found." };
              await api("/admin/notices/"+id+"/important", { method:"POST", body:{ important:!nc.important } });
              await loadPublic();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          /* Dismiss the important-notice banner for this member only. */
          dismissNotice: async (id)=>{
            try{
              await api("/notices/"+id+"/dismiss", { method:"POST" });
              await loadPublic();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          /* Support tickets (member side) */
          loadTickets: async ()=>{
            try{
              const r = await api("/support/tickets");
              setState(s=>({ ...s, tickets:r.tickets||[] }));
              return { ok:true, data:r.tickets||[] };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          addTicket: async ({type, subject, details})=>{
            try{
              const r = await api("/support/tickets", { method:"POST", body:{ type, subject, details } });
              await act.loadTickets();
              return { ok:true, id:r.id };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          loadTicket: async (id)=>{
            try{
              const r = await api("/support/tickets/"+id);
              return { ok:true, data:r };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          addTicketReply: async (id, body)=>{
            try{
              await api("/support/tickets/"+id+"/replies", { method:"POST", body:{ body } });
              await act.loadTickets();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          closeTicket: async (id)=>{
            try{
              await api("/support/tickets/"+id+"/close", { method:"POST" });
              await act.loadTickets();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          reopenTicket: async (id)=>{
            try{
              await api("/support/tickets/"+id+"/reopen", { method:"POST" });
              await act.loadTickets();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          /* Support tickets (staff side) */
          loadAdminTickets: async ()=>{
            try{
              const r = await api("/admin/support/tickets");
              setState(s=>({ ...s, adminTickets:r.tickets||[] }));
              return { ok:true, data:r.tickets||[] };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          loadAdminTicket: async (id)=>{
            try{
              const r = await api("/support/tickets/"+id);
              return { ok:true, data:r };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          addAdminTicketReply: async (id, body)=>{
            try{
              await api("/support/tickets/"+id+"/replies", { method:"POST", body:{ body } });
              await act.loadAdminTickets();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          /* Departments (admin side) */
          loadAdminDepartments: async ()=>{
            try{
              const r = await api("/admin/departments");
              setState(s=>({ ...s, adminDepartments:r.departments||[] }));
              return { ok:true, data:r.departments||[] };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          addDepartment: async (name)=>{
            try{
              await api("/admin/departments", { method:"POST", body:{ name } });
              await act.loadAdminDepartments();
              await loadPublic();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          renameDepartment: async (id, name)=>{
            try{
              await api("/admin/departments/"+id, { method:"PUT", body:{ name } });
              await act.loadAdminDepartments();
              await refreshAll();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          deleteDepartment: async (id)=>{
            try{
              await api("/admin/departments/"+id, { method:"DELETE" });
              await act.loadAdminDepartments();
              await loadPublic();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          addCourse: async ({dept, sem, code, title})=>{
            try{
              await api("/admin/courses", { method:"POST", body:{ dept, sem:semStr(sem), code, title } });
              await loadPublic();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          editCourse: async (id, {dept, sem, code, title})=>{
            try{
              await api("/admin/courses/"+id, { method:"PUT", body:{ dept, sem:semStr(sem), code, title } });
              await loadPublic();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          },
          deleteCourse: async (id)=>{
            try{
              await api("/admin/courses/"+id, { method:"DELETE" });
              await loadPublic();
              return { ok:true };
            }catch(e){ return { ok:false, error:e.message }; }
          }
        };

        if(loading){
          return html`<div class="view"><div class="wrap"><div class="page">
            <${EmptyState} title="Loading the portal…" body="Fetching the library from the server." />
          </div></div></div>`;
        }
        if(bootError){
          return html`<div class="view"><div class="wrap"><div class="page">
            <${EmptyState} title="Could not reach the server" body=${"The frontend could not talk to the backend ("+bootError+"). Start MySQL, then run “npm start” in the backend-mysql folder, and reload this page."}>
              <div class="cta"><button class="btn-gold" onClick=${()=>window.location.reload()}>Try again</button></div>
            </${EmptyState}>
          </div></div></div>`;
        }

        let body;
        if(user && user.suspended){
          /* A suspended account is signed out of everything until an admin unsuspends it */
          body = html`<div class="view"><div class="wrap"><div class="page">
            <${EmptyState} title="Your account is suspended" body="An admin has suspended this account, so you cannot upload, download or comment right now. If you think this is a mistake, contact the portal admin.">
              <div class="cta"><button class="btn-ink" onClick=${async ()=>{ await act.logout(); toast("You have been logged out."); go("home"); }}>Log out</button></div>
            </${EmptyState}>
          </div></div></div>`;
        }
        else if(view==="home") body = html`<${Home} state=${state} go=${go} />`;
        else if(view==="browse") body = html`<${Browse} key=${browseSeed.q+"|"+browseSeed.dept} state=${state} go=${go} initQ=${browseSeed.q} initDept=${browseSeed.dept} />`;
        else if(view==="notices") body = html`<${NoticeBoard} state=${state} go=${go} focusId=${focusNotice} />`;
        else if(view==="support") body = html`<${Support} key=${supportTicketId||"list"} state=${state} user=${user} go=${go} act=${act} toast=${toast} ticketId=${supportTicketId} />`;
        else if(view==="note") body = html`<${NoteDetail} state=${state} user=${user} noteId=${noteId} go=${go} act=${act} toast=${toast} />`;
        else if(view==="upload") body = html`<${Upload} state=${state} user=${user} go=${go} act=${act} toast=${toast} />`;
        else if(view==="login") body = html`<${Login} state=${state} go=${go} act=${act} toast=${toast} />`;
        else if(view==="register") body = html`<${Register} state=${state} go=${go} act=${act} toast=${toast} />`;
        else if(view==="forgot") body = html`<${Forgot} state=${state} go=${go} act=${act} toast=${toast} />`;
        else if(view==="contributor") body = html`<${ContributorProfile} key=${contributorId||"none"} state=${state} user=${user} contributorId=${contributorId} go=${go} act=${act} toast=${toast} />`;
        else if(view==="profile") body = html`<${Profile} key=${user?user.id:"anon"} state=${state} user=${user} go=${go} act=${act} toast=${toast} />`;
        else if(view==="admin") body = html`<${Admin} key=${"admin-"+adminTab} state=${state} user=${user} go=${go} act=${act} toast=${toast} initialTab=${adminTab} />`;

        return html`<div>
          <${Header} user=${user} state=${state} go=${go} view=${view} act=${act} toast=${toast} theme=${theme} toggleTheme=${toggleTheme} />
          <${ImportantNoticeBanner} state=${state} act=${act} toast=${toast} />
          <main key=${view+"-"+(noteId||"")+"-"+(contributorId||"")}>${body}</main>
          <${Footer} user=${user} go=${go} />
          ${toastMsg && html`<div class="toast" role="status">${toastMsg}</div>`}
        </div>`;
      }

      ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
