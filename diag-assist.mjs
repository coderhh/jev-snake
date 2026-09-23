// Verify the Laya snake now eats and grows with the code steering assist.
const LAYA = "http://127.0.0.1:8000/predict";
const GRID = 15;
const DIRS = { up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} };
const NAME = (d) => d.x===1?"right":d.x===-1?"left":d.y===1?"down":"up";
function placeFood(snake){while(true){const f={x:Math.floor(Math.random()*GRID),y:Math.floor(Math.random()*GRID)};if(!snake.some(s=>s.x===f.x&&s.y===f.y))return f;}}
(async()=>{
  const mid=Math.floor(GRID/2);
  let snake=[{x:mid,y:mid},{x:mid-1,y:mid},{x:mid-2,y:mid}];
  let dir={x:1,y:0}; let food=placeFood(snake); let score=0, assists=0;
  for(let i=0;i<60;i++){
    const body={snake,food,direction:NAME(dir),size:GRID};
    let j; try { const r=await fetch(LAYA,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}); j=await r.json(); } catch(e){ console.log("err",e.message); break; }
    if(!j.ok){ console.log("api err",j.error); break; }
    if(j.doomed){ console.log(`move ${i+1}: TRAPPED`); break; }
    if(j.assist) assists++;
    const nd=DIRS[j.direction]||dir;
    if(!(nd.x===-dir.x&&nd.y===-dir.y)) dir=nd;
    const head={x:snake[0].x+dir.x,y:snake[0].y+dir.y};
    if(head.x<0||head.y<0||head.x>=GRID||head.y>=GRID){ console.log(`DEAD wall len=${snake.length}`); break; }
    if(snake.some(s=>s.x===head.x&&s.y===head.y)){ console.log(`DEAD self len=${snake.length}`); break; }
    snake.unshift(head);
    if(head.x===food.x&&head.y===food.y){ score++; food=placeFood(snake); console.log(`move ${i+1}: ATE -> len=${snake.length} score=${score} (assists=${assists})`); }
    else snake.pop();
  }
  console.log(`final len=${snake.length} score=${score} assists=${assists}/${snake.length>3?snake.length-3:0} decisions`);
})().catch(e=>console.error(e));
