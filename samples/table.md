# 如何选择

| 场景 | 推荐 |
| --- | --- |
| 简单的 Prompt → LLM → 输出 | **LangChain LCEL** 就够了 |
| RAG 流水线（检索 → 拼接 → 生成） | **LangChain**，LCEL 表达力足够 |
| 单次工具调用的 Agent | **LangChain Agent** 即可 |
| 需要循环推理的 Agent（ReAct 模式） | **LangGraph**，显式控制循环 |
| 多 Agent 协作、子任务分发 | **LangGraph**，天然支持 |
| 需要人工审批节点（Human-in-the-Loop） | **LangGraph**，`interrupt` 机制 |
| 需要持久化、断点恢复的执行流程 | **LangGraph**，内置 Checkpointing |

| Left | Center | Right |
| :--- | :---: | ---: |
| a | b | c |
