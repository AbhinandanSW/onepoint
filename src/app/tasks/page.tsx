"use client";

import "@/app/tasks/tasks.css";
import { useState } from "react";

export default function Page() {
  const [tasks, setTasks] = useState<any[]>([]);

  const create_task = () => {

    const task_list =  Array(100).fill({ title: "hello testing", type: "task" , created_by:'you', created_at: Date.now()})
    const new_list: any[] = [
      ...tasks,
      ...task_list
    ];
    setTasks(new_list);
  };

  return (
    <div className="container">
      <div className="header">
        <h2 className="head">Task Organiser</h2>
        <button className="create_btn" onClick={create_task}>
          Create Task
        </button>
      </div>
      <p className="divider" />
      <div className="list">
        {tasks.map((item: any, index: number) => (
          <div className="card" key={`${index}_${item?.title}`}>
            <p className="title">
              ({item?.type} : {index + 1}) {item?.title}
            </p>
            <div className="info">
                <p className="at">created at : {item?.created_at}</p>
                <p className="by">created by : {item?.created_by}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
