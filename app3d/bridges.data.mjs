/**
 * 自动生成，请勿手工编辑。
 *
 * 来源：app.js 里的顶层字面量（2D 页面的权威数据）——
 *   bridges / comparisonProfiles / learningGoals / bridgeSources
 *   / sourceLibrary / quizQuestions
 * 重新生成：node tools/build-bridge-data.mjs
 * 校验是否过期：node tools/build-bridge-data.mjs --check（tests 里也会跑）
 *
 * 3D 场景用这份数据渲染：桥梁资料卡、结构实验室的力流讲解与压拉配色、
 * 档案馆的档案卡与知识点来源、以及知识挑战题库。
 */

export const BRIDGES = [
  {
    "id": "liujiang",
    "order": "01",
    "name": "柳江大桥",
    "alias": "柳江一桥 · LIUJIANG NO.1 BRIDGE",
    "year": "1968",
    "type": "梁桥",
    "family": "梁桥结构",
    "size": "608 m",
    "accent": "#f47c4d",
    "model": "girder",
    "deflectionBase": 8,
    "map": {
      "x": 35,
      "y": 65
    },
    "tag": "市区第一座跨江公路大桥",
    "tagline": "一条城市主轴，从江面上生长出来。",
    "description": "柳江大桥让柳江两岸第一次拥有了稳定的公路连接。桥面把车辆荷载交给主梁，主梁再通过桥墩与基础，将力量传到河床深处。它像一条简洁的城市基线，记录了柳州跨江交通的起点。",
    "tip": "点击桥面、主梁、桥墩或基础，观察一辆车带来的力量如何一路向下传递。",
    "observation": "桥面承接车辆，主梁发生弯曲，再把荷载交给桥墩和基础。",
    "parts": [
      {
        "id": "deck",
        "label": "桥面",
        "description": "桥面直接承受车辆和行人的重量，并把荷载交给下方的承重结构。"
      },
      {
        "id": "girder",
        "label": "主梁",
        "description": "主梁是梁桥的主要承重构件。车辆经过时，它会将荷载转化为弯曲变形并传向桥墩。"
      },
      {
        "id": "pier",
        "label": "桥墩",
        "description": "桥墩把主梁传来的竖向荷载继续向下传递，同时帮助桥梁跨越江面。"
      },
      {
        "id": "foundation",
        "label": "基础",
        "description": "基础藏在河水与河床之中，把整座桥的荷载分散到更稳定的地基里。"
      }
    ]
  },
  {
    "id": "wenhui",
    "order": "02",
    "name": "文惠桥",
    "alias": "WENHUI BRIDGE · 1994",
    "year": "1994",
    "type": "拱桥",
    "family": "中承式钢管混凝土拱桥",
    "size": "主桥 483 m",
    "accent": "#efb861",
    "model": "arch",
    "deflectionBase": 3.2,
    "map": {
      "x": 43,
      "y": 59
    },
    "tag": "广西首座中承式钢管混凝土拱桥",
    "tagline": "把重量变成弧线，让两岸在江上相遇。",
    "description": "文惠桥用一道醒目的拱肋跨过柳江。拱的主要工作方式不是“向下承重”，而是把竖向荷载转化为沿拱轴传递的压力。吊杆把桥面连接到拱肋，共同组成清晰的传力路径。",
    "tip": "依次点击拱肋、吊杆和桥面，理解为什么拱桥特别擅长把荷载转化为压力。",
    "observation": "桥面荷载经吊杆拉起，再由拱肋沿弧线把压力送到两岸拱座。",
    "parts": [
      {
        "id": "arch",
        "label": "拱肋",
        "description": "拱肋是拱桥的核心构件，主要承受沿拱轴方向的压力，把荷载送往两岸。"
      },
      {
        "id": "hanger",
        "label": "吊杆",
        "description": "吊杆把桥面与拱肋连接起来，通过受拉作用将桥面荷载悬吊到拱肋上。"
      },
      {
        "id": "deck",
        "label": "桥面梁",
        "description": "桥面梁承接车辆荷载，并通过吊杆逐段传递给上方的拱肋。"
      },
      {
        "id": "abutment",
        "label": "拱座",
        "description": "拱座位于拱的两端，为拱肋提供坚固的反力支撑，并继续把力量传给地基。"
      }
    ]
  },
  {
    "id": "wenchang",
    "order": "03",
    "name": "文昌大桥",
    "alias": "WENCHANG BRIDGE · 2005",
    "year": "2005",
    "type": "连续梁桥",
    "family": "预应力混凝土连续箱梁桥",
    "size": "1.713 km",
    "accent": "#6fa9ab",
    "model": "continuous",
    "deflectionBase": 6.5,
    "map": {
      "x": 52,
      "y": 52
    },
    "tag": "柳江第11座跨江大桥",
    "tagline": "让多个桥跨共同分担，让长桥保持从容。",
    "description": "文昌大桥采用连续箱梁结构，多个桥跨连成整体，车辆荷载可以在相邻桥跨之间重新分配。连续结构减少了桥面接缝，也让行车体验更加平顺。",
    "tip": "比较跨中与桥墩附近的响应，留意连续箱梁如何把相邻桥跨连接成一个整体。",
    "observation": "连续箱梁跨越多个桥墩，某一跨受力时，相邻桥跨也会参与分担。",
    "parts": [
      {
        "id": "box-girder",
        "label": "连续箱梁",
        "description": "连续箱梁跨越多个桥墩并连成整体，具有较好的抗弯与抗扭能力。"
      },
      {
        "id": "pier",
        "label": "桥墩",
        "description": "桥墩支撑连续梁的多个支点，将上部结构荷载传给基础。"
      },
      {
        "id": "bearing",
        "label": "支座",
        "description": "支座位于主梁与桥墩之间，负责传递荷载，同时允许结构产生必要的位移和转动。"
      },
      {
        "id": "mid-span",
        "label": "跨中",
        "description": "跨中是两座桥墩之间的中部区域，也是观察主梁弯曲变形最直观的位置。"
      }
    ]
  },
  {
    "id": "baisha",
    "order": "04",
    "name": "白沙大桥",
    "alias": "BAISHA BRIDGE · 2018",
    "year": "2018",
    "type": "斜拉桥",
    "family": "反对称全漂浮斜拉桥",
    "size": "环形主塔",
    "accent": "#eaa45b",
    "model": "cable",
    "deflectionBase": 5.5,
    "map": {
      "x": 62,
      "y": 43
    },
    "tag": "柳江第20座跨江大桥 · 柳州之门",
    "tagline": "一枚落在江面上的戒指，也是一扇城市之门。",
    "description": "白沙大桥拥有醒目的环形主塔。斜拉索把桥面荷载汇集到主塔，再由主塔传向基础。“全漂浮”体系让桥面与墩塔之间的关系更轻盈，也让结构受力组织更具特色。",
    "tip": "先点亮斜拉索，再观察主塔与桥面的关系：索在受拉，塔把力量压向基础。",
    "observation": "斜拉索承担拉力，把桥面重量集中到主塔，再由主塔传向大地。",
    "parts": [
      {
        "id": "ring",
        "label": "环形主塔",
        "description": "环形主塔是白沙大桥最有辨识度的结构，也是斜拉索力量汇集与转向的核心。"
      },
      {
        "id": "cable",
        "label": "斜拉索",
        "description": "斜拉索主要承受拉力，像一组张紧的琴弦，把桥面荷载提向主塔。"
      },
      {
        "id": "deck",
        "label": "漂浮桥面",
        "description": "全漂浮体系让桥面通过斜拉索与主塔协同工作，呈现出轻盈的跨江姿态。"
      },
      {
        "id": "anchor",
        "label": "锚固区",
        "description": "锚固区把斜拉索中的拉力可靠地传给主梁或塔身，是索力交接的重要节点。"
      }
    ]
  },
  {
    "id": "fenghuangling",
    "order": "05",
    "name": "凤凰岭大桥",
    "alias": "FENGHUANGLING BRIDGE · 2021",
    "year": "2021",
    "type": "风雨桥",
    "family": "跨江风雨桥造型",
    "size": "主桥 700 m",
    "accent": "#8bb391",
    "model": "pavilion",
    "deflectionBase": 4.2,
    "map": {
      "x": 73,
      "y": 34
    },
    "tag": "柳江第22座跨江大桥 · 五座风雨亭",
    "tagline": "桥不只在渡人，也在安放一座城市的文化记忆。",
    "description": "凤凰岭大桥把侗族风雨桥的建筑意象带进现代城市交通。五座风雨亭与桥面共同形成连续的城市景观。廊亭承担遮阳避雨的公共空间功能，真正的交通荷载仍由桥面梁、桥墩和基础体系承担。",
    "tip": "区分“建筑造型”与“承重结构”：风雨亭提供空间体验，桥面梁和桥墩负责通行安全。",
    "observation": "风雨亭塑造文化形象；桥面梁、桥墩和基础共同完成主要交通荷载传递。",
    "parts": [
      {
        "id": "pavilion",
        "label": "风雨亭",
        "description": "五座风雨亭延续了风雨桥的文化意象，为行人和城市提供有辨识度的公共空间。"
      },
      {
        "id": "gallery",
        "label": "连廊屋面",
        "description": "连续的屋面形成遮阳避雨的步行空间，也让整座桥的轮廓更完整。"
      },
      {
        "id": "deck",
        "label": "桥面梁",
        "description": "桥面梁承担机动车、非机动车与行人的主要交通荷载，是桥梁的交通承重界面。"
      },
      {
        "id": "pier",
        "label": "桥墩与基础",
        "description": "桥墩与基础把上部结构的力量传到河床，保障整座桥长期稳定工作。"
      }
    ]
  }
];

export const PROFILES = {
  "girder": {
    "force": "主梁主要受弯，桥墩受压",
    "members": "桥面 · 主梁 · 桥墩 · 基础",
    "scene": "城市道路、中等跨度跨江交通",
    "question": "车辆荷载如何经主梁传给桥墩？"
  },
  "arch": {
    "force": "拱肋主要受压，吊杆受拉",
    "members": "桥面梁 · 吊杆 · 拱肋 · 拱座",
    "scene": "需要较强跨越能力与景观表现",
    "question": "为什么拱肋能把荷载变成压力？"
  },
  "continuous": {
    "force": "连续箱梁受弯，多跨共同分担",
    "members": "连续箱梁 · 支座 · 桥墩 · 基础",
    "scene": "较长桥面、需要平顺行车体验",
    "question": "相邻桥跨如何参与荷载分担？"
  },
  "cable": {
    "force": "斜拉索受拉，主塔受压",
    "members": "漂浮桥面 · 斜拉索 · 环形主塔 · 锚固区",
    "scene": "大跨度、地标形象突出的城市桥梁",
    "question": "斜拉索把桥面重量提向哪里？"
  },
  "pavilion": {
    "force": "桥面梁受弯，风雨亭塑造公共空间",
    "members": "风雨亭 · 连廊 · 桥面梁 · 桥墩",
    "scene": "交通与文化形象并重的城市地标",
    "question": "建筑造型与承重结构如何区分？"
  }
};

export const GOALS = {
  "girder": "学完后，你能说明车辆荷载如何经主梁、桥墩和基础传向地基。",
  "arch": "学完后，你能解释拱肋为什么主要受压，以及吊杆如何把桥面提住。",
  "continuous": "学完后，你能说明连续箱梁为什么能让相邻桥跨共同分担荷载。",
  "cable": "学完后，你能区分斜拉索的拉力、主塔的受压和桥面的漂浮关系。",
  "pavilion": "学完后，你能区分风雨亭的文化造型与桥梁的真实承重体系。"
};

export const SOURCES = {
  "liujiang": [
    1,
    3
  ],
  "wenhui": [
    1,
    3
  ],
  "wenchang": [
    3
  ],
  "baisha": [
    1,
    3
  ],
  "fenghuangling": [
    2,
    3
  ]
};

export const SOURCE_LIBRARY = {
  "1": {
    "name": "广西新闻网",
    "url": "http://www.gxnews.com.cn/staticpages/20180917/newgx5b9ee61c-17651300.shtml"
  },
  "2": {
    "name": "澎湃新闻·柳州1号",
    "url": "https://www.thepaper.cn/newsDetail_forward_16077854"
  },
  "3": {
    "name": "柳州市文旅资料",
    "url": "https://news.sohu.com/a/507612954_121106875"
  }
};

export const QUIZ = [
  {
    "question": "柳江大桥建成于哪一年？",
    "options": [
      "1958年",
      "1968年",
      "1978年"
    ],
    "answer": 1,
    "explanation": "柳江大桥于1968年建成通车，是柳州市区第一座跨江公路大桥。"
  },
  {
    "question": "文惠桥最突出的结构特征是什么？",
    "options": [
      "中承式钢管混凝土拱桥",
      "双塔悬索桥",
      "全漂浮斜拉桥"
    ],
    "answer": 0,
    "explanation": "文惠桥是广西第一座中承式钢管混凝土拱桥，弧形的拱肋是它最醒目的结构语言。"
  },
  {
    "question": "连续梁桥把相邻桥跨连成整体，主要好处是什么？",
    "options": [
      "相邻桥跨可以共同分担荷载",
      "完全不再需要桥墩",
      "只依靠桥面铺装承重"
    ],
    "answer": 0,
    "explanation": "连续箱梁跨越多个桥墩并连成整体，某一跨受力时，相邻桥跨也会参与分担。"
  },
  {
    "question": "如何理解凤凰岭大桥的风雨亭与承重结构？",
    "options": [
      "风雨亭体现文化造型，交通荷载仍由桥梁结构承担",
      "所有交通荷载由屋顶承担",
      "风雨亭只是无作用的装饰"
    ],
    "answer": 0,
    "explanation": "风雨亭提供遮阳避雨与公共空间，真正的交通荷载由桥面梁、桥墩和基础体系承担。"
  },
  {
    "question": "斜拉桥中的斜拉索主要承受哪种力？",
    "options": [
      "压力",
      "拉力",
      "静摩擦力"
    ],
    "answer": 1,
    "explanation": "斜拉索处于张紧状态，主要承受拉力，把桥面荷载提向主塔。"
  },
  {
    "question": "拱桥的拱肋通常主要通过什么方式传力？",
    "options": [
      "沿拱轴传递压力",
      "只靠吊杆承重",
      "完全依靠桥墩抗拉"
    ],
    "answer": 0,
    "explanation": "拱的形态使竖向荷载可以转化为沿拱轴方向的压力，再传到两岸拱座。"
  }
];

export const BRIDGE_BY_ID = new Map(BRIDGES.map((bridge) => [bridge.id, bridge]));
