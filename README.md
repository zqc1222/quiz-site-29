# 第二十九期题库刷题台

这是从 `source.docx` 生成的本地静态刷题网站，直接打开 `index.html` 即可使用。

## 打开

双击：

```text
E:\workspace\codex\quiz-site\index.html
```

## 已包含

- 顺序练习、随机刷题、模拟考试
- 错题本、收藏夹、知识点填空
- 搜索题干、答案、选项
- 本地进度、笔记、正确率统计
- 进度导出和导入

## 重新生成题库数据

替换 `source.docx` 后运行：

```powershell
& 'C:\Users\张群策\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' 'E:\workspace\codex\quiz-site\tools\extract_docx_questions.py'
```

进度保存在浏览器 `localStorage` 中，不会写回 Word 文档。
