import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public class Threads {
    static int shared = 0;
    static synchronized void bump() { shared++; }
    public static void main(String[] args) throws Exception {
        Thread[] ts = new Thread[4];
        for (int i = 0; i < ts.length; i++) { ts[i] = new Thread(() -> { for (int j = 0; j < 1000; j++) bump(); }); ts[i].start(); }
        for (Thread t : ts) t.join();
        System.out.println("shared=" + shared);
        ExecutorService pool = Executors.newFixedThreadPool(3);
        List<Future<Integer>> fs = new ArrayList<>();
        for (int i = 1; i <= 5; i++) { final int n = i; fs.add(pool.submit(() -> n * n)); }
        int total = 0;
        for (Future<Integer> f : fs) total += f.get();
        pool.shutdown();
        System.out.println("squares=" + total + " terminated=" + pool.awaitTermination(5, TimeUnit.SECONDS));
        AtomicInteger ai = new AtomicInteger();
        ConcurrentHashMap<String, Integer> chm = new ConcurrentHashMap<>();
        IntStreamHelper.run(ai, chm);
        System.out.println("atomic=" + ai.get() + " chm=" + new TreeMap<>(chm));
        CompletableFuture<String> cf = CompletableFuture.supplyAsync(() -> "async").thenApply(s -> s + "!").thenCombine(CompletableFuture.completedFuture(1), (s, n) -> s + n);
        System.out.println(cf.get());
        CountDownLatch latch = new CountDownLatch(2);
        new Thread(latch::countDown).start(); new Thread(latch::countDown).start();
        System.out.println("latch " + latch.await(5, TimeUnit.SECONDS));
        long t0 = System.nanoTime(); Thread.sleep(50); long ms = (System.nanoTime() - t0) / 1_000_000;
        System.out.println("slept>=50: " + (ms >= 50) + " under 2s: " + (ms < 2000));
        Thread daemonless = new Thread(() -> { try { Thread.sleep(30); } catch (InterruptedException e) {} System.out.println("late thread finishes after main"); });
        daemonless.start();
        System.out.println("main ends; thread name " + Thread.currentThread().getName());
    }
    static class IntStreamHelper { static void run(AtomicInteger ai, ConcurrentHashMap<String, Integer> chm) throws Exception {
        List<Thread> ts = new ArrayList<>();
        for (int i = 0; i < 3; i++) { Thread t = new Thread(() -> { for (int j = 0; j < 100; j++) { ai.incrementAndGet(); chm.merge("k" + (j % 3), 1, Integer::sum); } }); ts.add(t); t.start(); }
        for (Thread t : ts) t.join();
    } }
}
