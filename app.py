"""
SmartBill Pro — app.py
=======================
Local:  python app.py
GAE:    gcloud app deploy

Database switches automatically:
  - Local → SQLite (billing.db)
  - GAE   → Cloud SQL PostgreSQL
"""
import os, json, io, random
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_file, Response
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room
import qrcode
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.platypus import (SimpleDocTemplate, Table, TableStyle,
                                Paragraph, Spacer, HRFlowable)
from reportlab.platypus import Image as RLImage
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.enums import TA_CENTER, TA_RIGHT

# ── Load .env if present (local dev) ────────────────────────────
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ── Paths ────────────────────────────────────────────────────────
BASE   = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, 'static')

# ── Detect environment ───────────────────────────────────────────
IS_GAE = os.environ.get('GAE_ENV', '').startswith('standard') or \
         os.environ.get('GAE_APPLICATION') is not None or \
         os.environ.get('DB_HOST', '').startswith('/cloudsql')

print(f"Environment: {'Google App Engine' if IS_GAE else 'Local'}")

# ── App setup ────────────────────────────────────────────────────
app = Flask(__name__, static_folder=None)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'smartbill-dev-secret')

CORS(app, resources={r"/*": {"origins": "*"}})
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode='eventlet' if IS_GAE else 'threading',
    logger=False,
    engineio_logger=False,
)

# ── Seed products ────────────────────────────────────────────────
SEEDS = [
    ('8902030401232','Parle-G Biscuits',         10,'Snacks',       '100g',  5, 200),
    ('8901030863013','Maggi 2-Min Noodles',       14,'Grocery',      '70g',   5, 150),
    ('8901233003049','Amul Butter',               58,'Dairy',       '100g',  12,  80),
    ('8906000510012','Aavin Full Cream Milk',     32,'Dairy',       '500ml',  0, 120),
    ('8906005111066','Sprite',                    40,'Beverage',    '750ml', 12,  90),
    ('8901719100025','Classmate Notebook',        45,'Stationery',  '200pg', 12,  60),
    ('8906001301038','Tata Salt',                 24,'Grocery',     '1kg',    5, 100),
    ('8901030000255','Britannia Good Day',        30,'Snacks',      '150g',   5, 180),
    ('8901063150348','Colgate Toothpaste',        89,'Personal Care','150g', 18,  75),
    ('8901764000012','Dettol Handwash',           99,'Personal Care','200ml',18,  50),
    ('8906006690013',"Lay's Classic Salted",      20,'Snacks',       '50g',  18, 120),
    ('8901063040019','Colgate Toothbrush',        65,'Personal Care','1pc',  18,  90),
    ('8901906007373','Tata Tea Premium',          62,'Grocery',     '100g',   5,  80),
    ('8901719103453','Classmate Pencil',           5,'Stationery',  '1pc',   12, 500),
    ('RICE1KG',      'India Gate Basmati Rice',   85,'Grocery',     '1kg',    5,  60),
]

# ══════════════════════════════════════════════════════════════════
#  DATABASE — switches between SQLite (local) and PostgreSQL (GAE)
# ══════════════════════════════════════════════════════════════════
if IS_GAE:
    # ── Cloud SQL PostgreSQL ──────────────────────────────────────
    import pg8000
    from google.cloud.sql.connector import Connector

    DB_HOST       = os.environ.get('DB_HOST', '')
    DB_NAME       = os.environ.get('DB_NAME', 'billing')
    DB_USER       = os.environ.get('DB_USER', 'smartbill')
    DB_PASS       = os.environ.get('DB_PASS', '')
    DB_CONN_NAME  = os.environ.get('DB_CONNECTION_NAME', '')

    _connector = Connector()

    def get_db():
        conn = _connector.connect(
            DB_CONN_NAME,
            "pg8000",
            user=DB_USER,
            password=DB_PASS,
            db=DB_NAME,
        )
        return conn

    def run_query(sql, params=(), fetch=False, many=False):
        conn = get_db(); cur = conn.cursor()
        if many:
            cur.executemany(sql, params)
        else:
            cur.execute(sql, params)
        result = cur.fetchall() if fetch else None
        conn.commit(); conn.close()
        return result

    def init_db():
        conn = get_db(); cur = conn.cursor()
        cur.execute('''CREATE TABLE IF NOT EXISTS products(
            id SERIAL PRIMARY KEY, barcode TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL, price REAL NOT NULL,
            category TEXT DEFAULT 'General', unit TEXT DEFAULT 'pcs',
            gst_rate REAL DEFAULT 5.0, stock INTEGER DEFAULT 100)''')
        cur.execute('''CREATE TABLE IF NOT EXISTS bills(
            id SERIAL PRIMARY KEY, bill_number TEXT NOT NULL,
            subtotal REAL, gst_total REAL, grand_total REAL,
            created_at TEXT, items_json TEXT)''')
        cur.execute('''CREATE TABLE IF NOT EXISTS sales_history(
            id SERIAL PRIMARY KEY, barcode TEXT NOT NULL,
            name TEXT NOT NULL, category TEXT NOT NULL,
            qty_sold INTEGER NOT NULL, sold_at TEXT NOT NULL)''')
        # Seed products
        for s in SEEDS:
            cur.execute(
                '''INSERT INTO products(barcode,name,price,category,unit,gst_rate,stock)
                   VALUES(%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT(barcode) DO NOTHING''', s)
        # Seed sales history
        cur.execute('SELECT COUNT(*) FROM sales_history')
        if cur.fetchone()[0] == 0:
            _seed_sales_pg(cur)
        conn.commit(); conn.close()
        print("Cloud SQL initialized")

    def _seed_sales_pg(cur):
        now = datetime.now(); wts=[12,8,6,7,9,4,10,11,5,4,13,5,9,6,7]
        for d in range(30,0,-1):
            day = now - timedelta(days=d)
            for idx in random.sample(range(len(SEEDS)), k=random.randint(5,11)):
                s=SEEDS[idx]; qty=max(1,int(random.gauss(wts[idx],2)))
                cur.execute(
                    'INSERT INTO sales_history(barcode,name,category,qty_sold,sold_at) VALUES(%s,%s,%s,%s,%s)',
                    (s[0],s[1],s[3],qty,day.isoformat()))

    def db_fetchall(sql, params=()):
        conn=get_db(); cur=conn.cursor()
        cur.execute(sql, params)
        cols=[d[0] for d in cur.description]
        rows=[dict(zip(cols,r)) for r in cur.fetchall()]
        conn.close(); return rows

    def db_fetchone(sql, params=()):
        conn=get_db(); cur=conn.cursor()
        cur.execute(sql, params)
        cols=[d[0] for d in cur.description]
        row=cur.fetchone()
        conn.close(); return dict(zip(cols,row)) if row else None

    def db_execute(sql, params=()):
        conn=get_db(); cur=conn.cursor()
        cur.execute(sql, params)
        conn.commit(); conn.close()

    def db_lastrow(sql, params=()):
        conn=get_db(); cur=conn.cursor()
        cur.execute(sql+' RETURNING id', params)
        r=cur.fetchone(); conn.commit(); conn.close(); return r

    PLACEHOLDER = '%s'

else:
    # ── Local SQLite ──────────────────────────────────────────────
    import sqlite3
    DB = os.path.join(BASE, 'billing.db')

    def get_db():
        c = sqlite3.connect(DB); c.row_factory = sqlite3.Row; return c

    def init_db():
        c=get_db(); cur=c.cursor()
        cur.execute('''CREATE TABLE IF NOT EXISTS products(
            id INTEGER PRIMARY KEY AUTOINCREMENT, barcode TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL, price REAL NOT NULL, category TEXT DEFAULT "General",
            unit TEXT DEFAULT "pcs", gst_rate REAL DEFAULT 5.0, stock INTEGER DEFAULT 100)''')
        cur.execute('''CREATE TABLE IF NOT EXISTS bills(
            id INTEGER PRIMARY KEY AUTOINCREMENT, bill_number TEXT NOT NULL,
            subtotal REAL, gst_total REAL, grand_total REAL,
            created_at TEXT, items_json TEXT)''')
        cur.execute('''CREATE TABLE IF NOT EXISTS sales_history(
            id INTEGER PRIMARY KEY AUTOINCREMENT, barcode TEXT NOT NULL,
            name TEXT NOT NULL, category TEXT NOT NULL,
            qty_sold INTEGER NOT NULL, sold_at TEXT NOT NULL)''')
        cur.executemany(
            'INSERT OR IGNORE INTO products(barcode,name,price,category,unit,gst_rate,stock) VALUES(?,?,?,?,?,?,?)',
            SEEDS)
        if cur.execute('SELECT COUNT(*) FROM sales_history').fetchone()[0] == 0:
            now=datetime.now(); wts=[12,8,6,7,9,4,10,11,5,4,13,5,9,6,7]
            for d in range(30,0,-1):
                day=now-timedelta(days=d)
                for idx in random.sample(range(len(SEEDS)),k=random.randint(5,11)):
                    s=SEEDS[idx]; qty=max(1,int(random.gauss(wts[idx],2)))
                    cur.execute(
                        'INSERT INTO sales_history(barcode,name,category,qty_sold,sold_at) VALUES(?,?,?,?,?)',
                        (s[0],s[1],s[3],qty,day.isoformat()))
        c.commit(); c.close()
        print("SQLite initialized")

    def db_fetchall(sql, params=()):
        c=get_db(); rows=[dict(r) for r in c.execute(sql,params).fetchall()]; c.close(); return rows

    def db_fetchone(sql, params=()):
        c=get_db(); row=c.execute(sql,params).fetchone(); c.close()
        return dict(row) if row else None

    def db_execute(sql, params=()):
        c=get_db(); c.execute(sql,params); c.commit(); c.close()

    def db_lastrow(sql, params=()):
        c=get_db(); cur=c.execute(sql,params); c.commit(); c.close(); return cur.lastrowid

    PLACEHOLDER = '?'

# ── Static file server ───────────────────────────────────────────
def serve_file(filepath):
    full = os.path.join(STATIC, filepath.replace('/', os.sep))
    if not os.path.exists(full):
        return Response(f'Not found: {filepath}', status=404)
    ext = os.path.splitext(filepath)[1].lower()
    mime = {'.html':'text/html;charset=utf-8','.css':'text/css;charset=utf-8',
            '.js':'application/javascript;charset=utf-8',
            '.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'}.get(ext,'text/plain')
    with open(full,'rb') as f: content=f.read()
    return Response(content, mimetype=mime)

# ── Pages ────────────────────────────────────────────────────────
@app.route('/')
def pg_index(): return serve_file('index.html')
@app.route('/scanner')
def pg_scanner(): return serve_file('scanner.html')
@app.route('/products')
def pg_products(): return serve_file('products.html')
@app.route('/analytics')
def pg_analytics(): return serve_file('analytics.html')
@app.route('/static/css/<path:f>')
def serve_css(f): return serve_file(f'css/{f}')
@app.route('/static/js/<path:f>')
def serve_js(f): return serve_file(f'js/{f}')
@app.route('/static/<path:f>')
def serve_static(f): return serve_file(f)

# ── WebSocket ─────────────────────────────────────────────────────
@socketio.on('connect')
def ws_connect(): print(f'WS connected: {request.sid}')

@socketio.on('join_session')
def ws_join(data):
    join_room(data.get('session_id','default'))
    emit('joined',{'ok':True})

@socketio.on('barcode_scanned')
def ws_barcode(data):
    sid=data.get('session_id','default'); code=data.get('barcode','').strip()
    if code:
        emit('barcode_received',{'barcode':code},room=sid,include_self=False)
        emit('scan_ok',{'barcode':code})

@socketio.on('phone_status')
def ws_phone(data):
    emit('phone_status',data,room=data.get('session_id','default'),include_self=False)

# ── Products API ──────────────────────────────────────────────────
@app.route('/api/products')
def api_products():
    return jsonify(db_fetchall(
        'SELECT * FROM products ORDER BY category,name'))

@app.route('/api/product/<bc>')
def api_product(bc):
    row=db_fetchone(f'SELECT * FROM products WHERE barcode={PLACEHOLDER}',(bc,))
    if row: return jsonify({'found':True,'product':row})
    return jsonify({'found':False}),404

@app.route('/api/products',methods=['POST'])
def api_add():
    d=request.json
    try:
        if IS_GAE:
            db_lastrow(
                f'INSERT INTO products(barcode,name,price,category,unit,gst_rate,stock) VALUES(%s,%s,%s,%s,%s,%s,%s)',
                (d['barcode'],d['name'],float(d['price']),d.get('category','General'),
                 d.get('unit','pcs'),float(d.get('gst_rate',5)),int(d.get('stock',100))))
        else:
            db_execute(
                'INSERT INTO products(barcode,name,price,category,unit,gst_rate,stock) VALUES(?,?,?,?,?,?,?)',
                (d['barcode'],d['name'],float(d['price']),d.get('category','General'),
                 d.get('unit','pcs'),float(d.get('gst_rate',5)),int(d.get('stock',100))))
        return jsonify({'success':True})
    except Exception as e:
        return jsonify({'success':False,'message':str(e)}),400

@app.route('/api/products/<int:pid>',methods=['PUT'])
def api_update(pid):
    d=request.json
    try:
        db_execute(
            f'UPDATE products SET barcode={PLACEHOLDER},name={PLACEHOLDER},price={PLACEHOLDER},category={PLACEHOLDER},unit={PLACEHOLDER},gst_rate={PLACEHOLDER},stock={PLACEHOLDER} WHERE id={PLACEHOLDER}',
            (d['barcode'],d['name'],float(d['price']),d.get('category','General'),
             d.get('unit','pcs'),float(d.get('gst_rate',5)),int(d.get('stock',0)),pid))
        return jsonify({'success':True})
    except Exception as e:
        return jsonify({'success':False,'message':str(e)}),400

@app.route('/api/products/<int:pid>',methods=['DELETE'])
def api_delete(pid):
    db_execute(f'DELETE FROM products WHERE id={PLACEHOLDER}',(pid,))
    return jsonify({'success':True})

@app.route('/api/products/search')
def api_search():
    q=request.args.get('q','')
    return jsonify(db_fetchall(
        f'SELECT * FROM products WHERE name LIKE {PLACEHOLDER} OR barcode LIKE {PLACEHOLDER} ORDER BY name',
        (f'%{q}%',f'%{q}%')))

# ── Analytics API ─────────────────────────────────────────────────
@app.route('/api/analytics/predictions')
def api_predictions():
    now=datetime.now()
    w1=(now-timedelta(days=7)).isoformat()
    w2=(now-timedelta(days=14)).isoformat()
    d14=(now-timedelta(days=14)).isoformat()

    last7={r['barcode']:r for r in db_fetchall(
        f'SELECT barcode,name,category,SUM(qty_sold) as total FROM sales_history WHERE sold_at>={PLACEHOLDER} GROUP BY barcode,name,category',(w1,))}
    prev7={r['barcode']:r['total'] for r in db_fetchall(
        f'SELECT barcode,SUM(qty_sold) as total FROM sales_history WHERE sold_at>={PLACEHOLDER} AND sold_at<{PLACEHOLDER} GROUP BY barcode',(w2,w1))}
    daily=db_fetchall(
        f'SELECT CAST(sold_at AS DATE) as day,SUM(qty_sold) as total FROM sales_history WHERE sold_at>={PLACEHOLDER} GROUP BY CAST(sold_at AS DATE) ORDER BY day',(d14,)) if IS_GAE else \
        db_fetchall(f"SELECT DATE(sold_at) as day,SUM(qty_sold) as total FROM sales_history WHERE sold_at>={PLACEHOLDER} GROUP BY DATE(sold_at) ORDER BY day",(d14,))
    cats=db_fetchall(
        f'SELECT category,SUM(qty_sold) as total FROM sales_history WHERE sold_at>={PLACEHOLDER} GROUP BY category ORDER BY total DESC',(w1,))
    prods={r['barcode']:r for r in db_fetchall('SELECT * FROM products')}

    preds=[]
    for bc,row in last7.items():
        cw=int(row['total']); pw=prev7.get(bc,max(1,cw//2)); tr=(cw-pw)/max(pw,1)
        pred=max(cw,int(cw*(1+tr*0.6))); stk=prods.get(bc,{}).get('stock',0)
        urg='critical' if stk<pred else 'low' if stk<pred*2 else 'ok'
        preds.append({'barcode':bc,'name':row['name'],'category':row['category'],
            'last_week':cw,'predicted':pred,'trend_pct':round(tr*100,1),
            'stock':stk,'urgency':urg,'price':prods.get(bc,{}).get('price',0)})
    preds.sort(key=lambda x:x['predicted'],reverse=True)
    return jsonify({'predictions':preds[:10],'daily_sales':daily,
        'category_sales':cats,'generated_at':now.isoformat()})

@app.route('/api/analytics/record_sale',methods=['POST'])
def api_record():
    items=request.json.get('items',[])
    for it in items:
        row=db_fetchone(f'SELECT category FROM products WHERE name={PLACEHOLDER}',(it['name'],))
        cat=row['category'] if row else 'General'
        db_execute(
            f'INSERT INTO sales_history(barcode,name,category,qty_sold,sold_at) VALUES({PLACEHOLDER},{PLACEHOLDER},{PLACEHOLDER},{PLACEHOLDER},{PLACEHOLDER})',
            (it.get('barcode',''),it['name'],cat,it['qty'],datetime.now().isoformat()))
    return jsonify({'success':True})

# ── PDF Bill ──────────────────────────────────────────────────────
@app.route('/api/bill/pdf',methods=['POST'])
def api_pdf():
    d=request.json; items=d['items']
    sub=float(d['subtotal']); gst=float(d['gst_total']); grand=float(d['grand_total'])
    uid=d.get('upi_id','yourname@upi'); store=d.get('store_name','SmartBill Store')
    bn=d.get('bill_number','BILL-'+datetime.now().strftime('%Y%m%d%H%M%S'))
    db_execute(
        f'INSERT INTO bills(bill_number,subtotal,gst_total,grand_total,created_at,items_json) VALUES({PLACEHOLDER},{PLACEHOLDER},{PLACEHOLDER},{PLACEHOLDER},{PLACEHOLDER},{PLACEHOLDER})',
        (bn,sub,gst,grand,datetime.now().isoformat(),json.dumps(items)))
    qs=f"upi://pay?pa={uid}&pn={store}&am={grand:.2f}&cu=INR&tn={bn}"
    qb=io.BytesIO(); qrcode.make(qs).save(qb,'PNG'); qb.seek(0)
    pb=io.BytesIO()
    doc=SimpleDocTemplate(pb,pagesize=A4,leftMargin=15*mm,rightMargin=15*mm,topMargin=15*mm,bottomMargin=15*mm)
    S=getSampleStyleSheet()
    CC=ParagraphStyle('cc',parent=S['Normal'],alignment=TA_CENTER)
    CR=ParagraphStyle('cr',parent=S['Normal'],alignment=TA_RIGHT)
    CT=ParagraphStyle('ct',parent=S['Title'],alignment=TA_CENTER,fontSize=22,fontName='Helvetica-Bold')
    CS=ParagraphStyle('cs',parent=S['Normal'],alignment=TA_CENTER,fontSize=9,textColor=colors.HexColor('#555'))
    story=[Paragraph(store,CT),Paragraph('Tax Invoice',CS),Spacer(1,4*mm),
           HRFlowable(width='100%',thickness=1.5,color=colors.HexColor('#6366f1')),Spacer(1,3*mm)]
    now2=datetime.now().strftime('%d %b %Y  %I:%M %p')
    mt=Table([[Paragraph(f'<b>Bill No:</b> {bn}',S['Normal']),Paragraph(f'<b>Date:</b> {now2}',CR)]],colWidths=['55%','45%'])
    mt.setStyle(TableStyle([('BOTTOMPADDING',(0,0),(-1,-1),6)])); story+=[mt,Spacer(1,4*mm)]
    hdr=[Paragraph(f'<b>{t}</b>',CC if t in('#','Qty','GST%') else CR if t=='Amount' else S['Normal'])
         for t in ['#','Product','Unit','Qty','Rate','GST%','Amount']]
    rows=[hdr]
    for i,it in enumerate(items,1):
        amt=it['price']*it['qty']
        rows.append([Paragraph(str(i),CC),Paragraph(it['name'],S['Normal']),
                     Paragraph(it.get('unit',''),CC),Paragraph(str(it['qty']),CC),
                     Paragraph(f"Rs.{it['price']:.2f}",CR),
                     Paragraph(f"{it.get('gst_rate',5):.0f}%",CC),
                     Paragraph(f"Rs.{amt:.2f}",CR)])
    tbl=Table(rows,colWidths=[10*mm,65*mm,18*mm,14*mm,22*mm,16*mm,25*mm],repeatRows=1)
    tbl.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),colors.HexColor('#6366f1')),
        ('TEXTCOLOR',(0,0),(-1,0),colors.white),
        ('FONTNAME',(0,0),(-1,0),'Helvetica-Bold'),('FONTSIZE',(0,0),(-1,-1),9),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#f5f3ff')]),
        ('GRID',(0,0),(-1,-1),0.3,colors.HexColor('#ccc')),
        ('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5),
        ('LEFTPADDING',(0,0),(-1,-1),4),('RIGHTPADDING',(0,0),(-1,-1),4)]))
    story+=[tbl,Spacer(1,5*mm)]
    tot=Table([['Subtotal',f'Rs.{sub:.2f}'],['GST',f'Rs.{gst:.2f}'],['Grand Total',f'Rs.{grand:.2f}']],colWidths=[140*mm,30*mm])
    tot.setStyle(TableStyle([('ALIGN',(1,0),(1,-1),'RIGHT'),('FONTSIZE',(0,0),(-1,-1),10),
        ('FONTNAME',(0,2),(-1,2),'Helvetica-Bold'),('FONTSIZE',(0,2),(-1,2),13),
        ('TEXTCOLOR',(0,2),(-1,2),colors.HexColor('#6366f1')),
        ('LINEABOVE',(0,2),(-1,2),1,colors.HexColor('#6366f1')),
        ('TOPPADDING',(0,0),(-1,-1),4),('BOTTOMPADDING',(0,0),(-1,-1),4)]))
    story+=[tot,Spacer(1,6*mm),HRFlowable(width='100%',thickness=0.5,color=colors.HexColor('#ccc')),
            Spacer(1,5*mm),Paragraph('Scan to Pay',CS),Spacer(1,3*mm)]
    qi=RLImage(qb,width=48*mm,height=48*mm); qi.hAlign='CENTER'
    story+=[qi,Spacer(1,2*mm),Paragraph('PhonePe · GPay · Paytm · Any UPI App',CS),
            Paragraph(f'<b>Rs.{grand:.2f}</b>',CC),Spacer(1,6*mm),
            Paragraph('Thank you for shopping with us!',CC)]
    doc.build(story); pb.seek(0)
    return send_file(pb,mimetype='application/pdf',as_attachment=True,download_name=f'{bn}.pdf')

# ── Boot ──────────────────────────────────────────────────────────
# Initialize DB when module loads (needed for GAE)
init_db()

if __name__ == '__main__':
    print('\n'+'='*55)
    print('  SmartBill Pro — LOCAL mode')
    print('  Open: http://localhost:5000')
    print('='*55+'\n')
    socketio.run(app, host='0.0.0.0', port=5000,
                 debug=False, allow_unsafe_werkzeug=True)
