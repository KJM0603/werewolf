from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
from reportlab.lib.colors import HexColor

OUT = r'output/pdf/one-night-ultimate-werewolf-korean-guide.pdf'
pdfmetrics.registerFont(TTFont('Malgun', r'C:\Windows\Fonts\malgun.ttf'))
pdfmetrics.registerFont(TTFont('Malgun-Bold', r'C:\Windows\Fonts\malgunbd.ttf'))
NAVY = HexColor('#18243A')
PURPLE = HexColor('#5B4BC4')
PALE = HexColor('#F2F1FC')
INK = HexColor('#263247')
MUTED = HexColor('#657189')
GOLD = HexColor('#E8B54A')

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='TitleK', fontName='Malgun-Bold', fontSize=24, leading=31, textColor=NAVY, spaceAfter=7))
styles.add(ParagraphStyle(name='SubK', fontName='Malgun', fontSize=10, leading=15, textColor=MUTED, spaceAfter=13))
styles.add(ParagraphStyle(name='HeadK', fontName='Malgun-Bold', fontSize=15, leading=20, textColor=NAVY, spaceBefore=8, spaceAfter=8))
styles.add(ParagraphStyle(name='SubHeadK', fontName='Malgun-Bold', fontSize=11, leading=16, textColor=PURPLE, spaceBefore=5, spaceAfter=4))
styles.add(ParagraphStyle(name='BodyK', fontName='Malgun', fontSize=9.5, leading=15, textColor=INK, spaceAfter=5))
styles.add(ParagraphStyle(name='SmallK', fontName='Malgun', fontSize=8, leading=12, textColor=MUTED, spaceAfter=3))
styles.add(ParagraphStyle(name='CellK', fontName='Malgun', fontSize=8.7, leading=13, textColor=INK))
styles.add(ParagraphStyle(name='CellBoldK', fontName='Malgun-Bold', fontSize=8.8, leading=13, textColor=NAVY))
styles.add(ParagraphStyle(name='CalloutK', fontName='Malgun-Bold', fontSize=10, leading=16, textColor=NAVY))
styles.add(ParagraphStyle(name='CoverK', fontName='Malgun-Bold', fontSize=12, leading=18, textColor=NAVY))

P = lambda s, style='BodyK': Paragraph(s, styles[style])
def bullet(s): return P('• ' + s)
def section(title): return P(title, 'HeadK')
def card(data, widths):
    t = Table(data, colWidths=widths, hAlign='LEFT')
    t.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),PALE), ('TEXTCOLOR',(0,0),(-1,0),NAVY),
        ('FONTNAME',(0,0),(-1,-1),'Malgun'), ('VALIGN',(0,0),(-1,-1),'TOP'),
        ('GRID',(0,0),(-1,-1),0.35,HexColor('#D9DCE8')),
        ('LEFTPADDING',(0,0),(-1,-1),8), ('RIGHTPADDING',(0,0),(-1,-1),8),
        ('TOPPADDING',(0,0),(-1,-1),6), ('BOTTOMPADDING',(0,0),(-1,-1),6),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,HexColor('#FAFAFD')]),
    ]))
    return t

def footer(canvas, doc):
    canvas.saveState()
    w,h=A4
    canvas.setFillColor(NAVY); canvas.rect(0,h-7*mm,w,7*mm,fill=1,stroke=0)
    canvas.setFillColor(GOLD); canvas.rect(0,h-7*mm,24*mm,1.2*mm,fill=1,stroke=0)
    canvas.setStrokeColor(HexColor('#D9DCE8')); canvas.line(18*mm,14*mm,w-18*mm,14*mm)
    canvas.setFont('Malgun',7.5); canvas.setFillColor(MUTED)
    canvas.drawString(18*mm,9*mm,'한밤의 늑대인간 | 한국어 플레이 참고서')
    canvas.drawRightString(w-18*mm,9*mm,f'{doc.page}')
    canvas.restoreState()

doc = SimpleDocTemplate(OUT, pagesize=A4, rightMargin=18*mm, leftMargin=18*mm, topMargin=16*mm, bottomMargin=20*mm, title='한밤의 늑대인간 한국어 플레이 참고서', author='OpenAI')
story=[]
story += [Spacer(1,12*mm), P('한밤의<br/>늑대인간','TitleK'), P('한국어 플레이 참고서 · 기본 진행과 승리 조건','SubK')]
story += [card([[P('한눈에 보기','CellBoldK'),P('한 번의 밤, 한 번의 토론과 투표로 끝나는 추리 게임입니다. 밤중 역할 행동으로 카드가 바뀔 수 있으므로, 처음 받은 역할과 게임 종료 시 역할을 구분해서 판정합니다.','CellK')]], [34*mm,130*mm]), Spacer(1,7*mm)]
story += [P('이 문서는 공식 규칙서의 전문 번역이 아니라, 공개된 공식 규칙을 바탕으로 자체 표현으로 정리한 플레이 요약입니다. 앱에서 구현한 역할의 간단한 설명과 승리 판정을 포함합니다.','BodyK')]
story += [section('1. 준비')]
story += [bullet('3~10명이 플레이합니다. 참가자 수보다 역할 카드를 3장 더 준비합니다. 예: 5명이면 역할 8장, 그중 5장을 플레이어에게 나누고 나머지 3장은 중앙에 둡니다.'), bullet('사용할 역할 조합을 고르고 섞은 뒤, 각자 카드 한 장을 비공개로 확인합니다. 중앙 카드 3장은 밤 행동 중 교환되거나 일부 역할이 확인할 수 있습니다.'), bullet('진행자는 역할을 정해진 순서대로 부릅니다. 앱은 안내와 타이머를 제공할 수 있지만, 역할 행동과 토론은 참가자들이 함께 진행합니다.')]
story += [section('2. 한 라운드의 흐름')]
story += [card([
 [P('밤','CellBoldK'),P('진행자 안내에 맞춰 역할별로 눈을 뜨고 능력을 사용합니다. 카드를 바꾸는 능력이 있으므로 실제 최종 역할은 처음 받은 카드와 달라질 수 있습니다.','CellK')],
 [P('토론','CellBoldK'),P('모두 눈을 뜨고 정보를 나눕니다. 누가 늑대인간인지 추리하되, 역할을 숨기거나 거짓말하는 것도 전략의 일부입니다.','CellK')],
 [P('동시 투표','CellBoldK'),P('신호에 맞춰 모두 한 명을 동시에 지목합니다. 가장 많은 표를 받은 사람이 사망합니다. 최다 득표가 동률이면 해당 인원이 모두 사망합니다.','CellK')],
 [P('사망자 판정','CellBoldK'),P('어떤 사람도 2표 이상 받지 않았다면 사망자는 없습니다. 사망자를 확정한 뒤, 게임 종료 시점의 역할을 기준으로 각 팀의 승리를 판정합니다.','CellK')]
], [28*mm,136*mm]), Spacer(1,4*mm), P('중요: 한 표씩만 받은 경우에는 “가장 표를 많이 받은 사람”이 있더라도 아무도 죽지 않습니다. 사망 판정 기준은 최다 득표자의 표가 2표 이상인지입니다.','SmallK'), PageBreak()]

story += [P('역할 카드','TitleK'), P('현재 앱에서 선택할 수 있는 역할의 밤 능력 요약입니다. 팀 승리는 아래 3쪽의 종료 판정과 함께 확인하세요.','SubK')]
roles = [
 ('도플갱어','밤 초반에 다른 한 명의 처음 역할을 확인하고 그 역할을 복사합니다. 복사한 역할의 즉시 밤 행동이 있다면 이어서 수행합니다. 종료 승리 조건도 복사한 역할을 따릅니다.'),
 ('늑대인간','늑대인간끼리 서로 확인합니다. 혼자 깨어난 늑대인간은 중앙 카드 한 장을 확인할 수 있습니다.'),
 ('하수인','늑대인간 다음에 깨어나 늑대인간을 확인합니다. 늑대인간은 하수인의 정체를 확인하지 못합니다.'),
 ('예언자','다른 플레이어 한 명의 카드를 보거나, 중앙 카드 두 장을 확인합니다.'),
 ('강도','다른 플레이어 한 명과 카드를 맞바꾸고, 바뀐 자신의 카드를 확인합니다. 바뀐 역할의 밤 능력은 추가로 수행하지 않습니다.'),
 ('말썽쟁이','자신을 제외한 두 플레이어의 카드를 서로 바꿉니다. 카드 내용을 보지는 않습니다.'),
 ('주정뱅이','중앙 카드 한 장과 자신의 카드를 맞바꾸지만 새 카드는 확인하지 않습니다.'),
 ('불면증 환자','밤 마지막에 자신의 카드를 확인해 밤중에 역할이 바뀌었는지 알아봅니다.'),
 ('주민','밤 능력은 없습니다. 최종 역할이 주민이면 마을 팀의 승리 조건을 따릅니다.'),
 ('무두장이','밤 능력은 없습니다. 자신의 생존이 아니라 투표로 자신이 사망했는지가 승리 조건입니다.'),
]
story += [card([[P('역할','CellBoldK'),P('밤 행동 및 판정 메모','CellBoldK')]] + [[P(n,'CellBoldK'),P(d,'CellK')] for n,d in roles], [33*mm,131*mm]), Spacer(1,4*mm)]
story += [P('역할 행동이 끝나면 모두 동시에 깨어납니다. 밤 행동으로 카드가 이동한 경우에는 처음 역할이 아니라 최종 역할이 승리 팀을 결정합니다. 도플갱어는 복사한 역할에 따라 별도로 판정합니다.','SmallK'), PageBreak()]

story += [P('승리 조건','TitleK'), P('먼저 최종 역할과 사망자를 확정한 다음, 아래 기준을 적용합니다. 여러 조건이 동시에 성립하면 서로 다른 역할이나 팀이 함께 승리할 수 있습니다.','SubK')]
winrows = [
 [P('마을 팀','CellBoldK'),P('최종 역할이 늑대인간인 플레이어가 한 명 이상 사망하면 승리합니다. 늑대인간 플레이어가 한 명도 없다면, 아무도 사망하지 않았을 때 승리합니다.','CellK')],
 [P('늑대인간 팀','CellBoldK'),P('플레이어 중 늑대인간이 적어도 한 명 있고, 늑대인간이 사망하지 않으면 승리합니다. 단, 무두장이가 사망했는데 늑대인간은 살아 있으면 늑대인간 팀은 승리하지 못합니다. 하수인은 늑대인간 팀과 함께 승리하며, 이때 하수인이 사망해도 팀 승리는 유지됩니다.','CellK')],
 [P('하수인 단독 승리','CellBoldK'),P('플레이어 중 늑대인간이 한 명도 없을 때 적용됩니다. 하수인 본인은 살아남고, 하수인 본인 이외의 플레이어가 투표로 사망하면 하수인이 승리합니다. 사망자가 무두장이여도 이 조건을 만족합니다. 하수인 본인이 사망하면 이 조건으로는 승리하지 못합니다.','CellK')],
 [P('무두장이','CellBoldK'),P('투표로 사망하면 무두장이가 승리합니다. 무두장이만 죽고 늑대인간이 죽지 않았다면 마을 팀과 늑대인간 팀은 승리하지 않습니다. 무두장이와 늑대인간이 함께 죽으면 무두장이와 마을 팀이 모두 승리할 수 있습니다.','CellK')]
]
story += [card([[P('팀/역할','CellBoldK'),P('승리 판정','CellBoldK')]]+winrows,[34*mm,130*mm]), Spacer(1,7*mm)]
story += [P('요청하신 규칙 확인','HeadK')]
story += [P('하수인의 추가 조건은 “늑대인간이 플레이어 중에 없을 때, 자신 이외의 플레이어가 죽는 것”입니다. 따라서 하수인이 살아 있고 무두장이가 사망한 경우, 무두장이는 자기 승리를 얻고 하수인도 별도의 조건으로 승리할 수 있습니다. 반대로 하수인만 사망하고 다른 플레이어가 죽지 않으면 하수인은 이 조건으로 승리하지 않습니다.','BodyK')]
story += [P('공식 출처','HeadK')]
story += [P('Bézier Games 공식 상품 페이지(게임 개요 및 규칙서 링크): <link href="https://beziergames.com/collections/all-games/products/one-night-ultimate-werewolf?mobile-app=true" color="#5B4BC4">공식 페이지 열기</link>','SmallK')]
story += [P('Bézier Games 공식 규칙서 PDF: <link href="https://cdn.shopify.com/s/files/1/0740/4855/files/ONUW_rules-updated_for_BGG.pdf?337=" color="#5B4BC4">ONUW_rules-updated_for_BGG.pdf</link>','SmallK')]
story += [P('공식 규칙서의 하수인 역할 설명과 무두장이 예외 규칙을 함께 적용해 요약했습니다. 확인일: 2026-10-20. 본 문서는 비공식 참고 자료이며 공식 규칙서의 대체물이 아닙니다.','SmallK')]

doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
