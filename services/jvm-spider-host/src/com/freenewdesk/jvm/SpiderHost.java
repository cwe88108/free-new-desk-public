package com.freenewdesk.jvm;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

public final class SpiderHost {
  private static final Map<String, LoadedSpider> spiders = new ConcurrentHashMap<>();
  private record LoadedSpider(URLClassLoader loader, Object instance) {}
  public static void main(String[] args) throws Exception {
    try (BufferedReader reader=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8));BufferedWriter writer=new BufferedWriter(new OutputStreamWriter(System.out,StandardCharsets.UTF_8))) {
      String line;while((line=reader.readLine())!=null){if(line.isBlank())continue;String response;try{response=handle(line);}catch(Throwable error){response="ERR\t"+safeId(line)+"\t"+enc(message(error));}writer.write(response);writer.newLine();writer.flush();}
    } finally {for(LoadedSpider loaded:spiders.values())try{loaded.loader().close();}catch(IOException ignored){}}
  }
  private static String handle(String line) throws Exception {
    String[] parts=line.split("\\t",-1);if(parts.length<2)throw new IllegalArgumentException("Malformed request");String command=parts[0],id=parts[1];
    if("PING".equals(command))return "OK\t"+id+"\t"+enc("1.2.0");
    if("INIT".equals(command)){if(parts.length<6)throw new IllegalArgumentException("INIT requires source, jar, class and ext");String sourceId=dec(parts[2]),jarPath=dec(parts[3]),className=dec(parts[4]),ext=dec(parts[5]);Path jar=Paths.get(jarPath).toAbsolutePath().normalize();if(!Files.isRegularFile(jar))throw new FileNotFoundException("Spider JAR not found");URLClassLoader loader=new URLClassLoader(new URL[]{jar.toUri().toURL()},SpiderHost.class.getClassLoader());Class<?> type=Class.forName(className,true,loader);Object instance=type.getDeclaredConstructor().newInstance();LoadedSpider previous=spiders.put(sourceId,new LoadedSpider(loader,instance));if(previous!=null)previous.loader().close();if(!invokeOptional(instance,"init",new String[]{ext}))invokeOptional(instance,"init",new String[]{});return "OK\t"+id+"\t"+enc("true");}
    if("CALL".equals(command)){if(parts.length<5)throw new IllegalArgumentException("CALL requires source, method and argument count");String sourceId=dec(parts[2]),method=dec(parts[3]);int count=Integer.parseInt(parts[4]);if(parts.length<5+count)throw new IllegalArgumentException("CALL argument count mismatch");LoadedSpider loaded=spiders.get(sourceId);if(loaded==null)throw new IllegalStateException("Spider not initialized");String[] values=new String[count];for(int i=0;i<count;i++)values[i]=dec(parts[5+i]);Object result=invokeBest(loaded.instance(),method,values);return "OK\t"+id+"\t"+enc(result==null?"":String.valueOf(result));}
    if("DESTROY".equals(command)){if(parts.length<3)throw new IllegalArgumentException("DESTROY requires source");String sourceId=dec(parts[2]);LoadedSpider loaded=spiders.remove(sourceId);if(loaded!=null)loaded.loader().close();return "OK\t"+id+"\t"+enc("true");}
    throw new IllegalArgumentException("Unsupported command: "+command);
  }
  private static Object invokeBest(Object instance,String method,String[] values)throws Exception{java.lang.reflect.Method best=null;for(java.lang.reflect.Method candidate:instance.getClass().getMethods())if(candidate.getName().equals(method)&&candidate.getParameterCount()==values.length){try{Object[] converted=convertAll(values,candidate.getParameterTypes());best=candidate;try{return best.invoke(instance,converted);}catch(IllegalArgumentException ignored){}}catch(RuntimeException ignored){}}if(best==null)throw new NoSuchMethodException(instance.getClass().getName()+"."+method+"/"+values.length);throw new IllegalArgumentException("No compatible overload: "+method);}
  private static Object[] convertAll(String[] values,Class<?>[] types){Object[] converted=new Object[values.length];for(int i=0;i<values.length;i++)converted[i]=convert(values[i],types[i]);return converted;}
  private static boolean invokeOptional(Object instance,String method,String[] values)throws Exception{try{invokeBest(instance,method,values);return true;}catch(NoSuchMethodException|IllegalArgumentException ignored){return false;}}
  private static Object convert(String value,Class<?> type){if(type==String.class||type==Object.class)return value;if(type==int.class||type==Integer.class)return Integer.parseInt(value);if(type==long.class||type==Long.class)return Long.parseLong(value);if(type==boolean.class||type==Boolean.class)return Boolean.parseBoolean(value);if(type==double.class||type==Double.class)return Double.parseDouble(value);if(List.class.isAssignableFrom(type))return value.isEmpty()?new ArrayList<String>():new ArrayList<>(Arrays.asList(value.split("\\u001f",-1)));if(Map.class.isAssignableFrom(type)){Map<String,String> map=new HashMap<>();String json=value.trim();if(json.startsWith("{")&&json.endsWith("}")){String inner=json.substring(1,json.length()-1).trim();if(!inner.isEmpty())for(String pair:inner.split(",")){int colon=pair.indexOf(':');if(colon>0)map.put(strip(pair.substring(0,colon)),strip(pair.substring(colon+1)));}}return map;}return value;}
  private static String strip(String value){String text=value.trim();if(text.length()>=2&&text.startsWith("\"")&&text.endsWith("\""))text=text.substring(1,text.length()-1);return text.replace("\\\"","\"").replace("\\\\","\\");}
  private static String enc(String value){return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));}private static String dec(String value){if(value.isEmpty())return "";return new String(Base64.getUrlDecoder().decode(value),StandardCharsets.UTF_8);}private static String safeId(String line){int first=line.indexOf('\t');if(first<0)return "unknown";int second=line.indexOf('\t',first+1);return second<0?line.substring(first+1):line.substring(first+1,second);}private static String message(Throwable error){Throwable root=error instanceof java.lang.reflect.InvocationTargetException&&error.getCause()!=null?error.getCause():error;String value=root.getMessage();return root.getClass().getSimpleName()+(value==null?"":": "+value);}
}
